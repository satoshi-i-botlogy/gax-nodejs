/**
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// This file implements gRPC to HTTP transcoding, as described in
// https://cloud.google.com/endpoints/docs/grpc-service-config/reference/rpc/google.api#grpc-transcoding

import {google} from '../protos/http';
import {RequestType} from './apitypes';

export interface TranscodedRequest {
  httpMethod: string;
  url: string;
  queryString: string;
  data: string | {};
}

const httpOptionName = '(google.api.http)';

// The following type is here only to make tests type safe
type allowedOptions = '(google.api.method_signature)';

const supportedHttpMethods = ['get', 'post', 'put', 'patch', 'delete'];

export type ParsedOptionsType = Array<
  {
    [httpOptionName]?: google.api.IHttpRule;
  } & {
    [option in allowedOptions]?: {} | string | number;
  }
>;

export function getField(
  request: RequestType,
  field: string
): string | number | Array<string | number> | undefined {
  const parts = field.split('.');
  let value: RequestType | string | number | undefined = request;
  for (const part of parts) {
    if (typeof value !== 'object') {
      return undefined;
    }
    value = (value as RequestType)[part] as RequestType;
  }
  if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
    return undefined;
  }
  return value;
}

export function deepCopy(request: RequestType): RequestType {
  if (typeof request !== 'object' || request === null) {
    return request;
  }
  const copy = Object.assign({}, request);
  for (const key in copy) {
    if (Array.isArray(copy[key])) {
      copy[key] = (copy[key] as RequestType[]).map(deepCopy);
    } else if (typeof copy[key] === 'object' && copy[key] !== null) {
      copy[key] = deepCopy(copy[key] as RequestType);
    }
  }
  return copy;
}

export function deleteField(request: RequestType, field: string): void {
  const parts = field.split('.');
  while (parts.length > 1) {
    if (typeof request !== 'object') {
      return;
    }
    const part = parts.shift() as string;
    request = request[part] as RequestType;
  }
  const part = parts.shift() as string;
  if (typeof request !== 'object') {
    return;
  }
  delete request[part];
}

export function buildQueryStringComponents(
  request: RequestType,
  prefix = ''
): string[] {
  const resultList = [];
  for (const key in request) {
    if (Array.isArray(request[key])) {
      for (const value of request[key] as RequestType[]) {
        resultList.push(
          `${prefix}${encodeWithoutSlashes(key)}=${encodeWithoutSlashes(
            value.toString()
          )}`
        );
      }
    } else if (typeof request[key] === 'object' && request[key] !== null) {
      resultList.push(
        ...buildQueryStringComponents(request[key] as RequestType, `${key}.`)
      );
    } else {
      resultList.push(
        `${prefix}${encodeWithoutSlashes(key)}=${encodeWithoutSlashes(
          request[key].toString()
        )}`
      );
    }
  }
  return resultList;
}

export function encodeWithSlashes(str: string): string {
  return str
    .split('')
    .map(c => (c.match(/[-_.~0-9a-zA-Z]/) ? c : encodeURIComponent(c)))
    .join('');
}

export function encodeWithoutSlashes(str: string): string {
  return str
    .split('')
    .map(c => (c.match(/[-_.~0-9a-zA-Z/]/) ? c : encodeURIComponent(c)))
    .join('');
}

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyPattern(
  pattern: string,
  fieldValue: string
): string | undefined {
  if (!pattern || pattern === '*') {
    return encodeWithSlashes(fieldValue);
  }

  if (!pattern.includes('*') && pattern !== fieldValue) {
    return undefined;
  }

  // since we're converting the pattern to a regex, make necessary precautions:
  const regex = new RegExp(
    '^' +
      escapeRegExp(pattern)
        .replace(/\\\*\\\*/g, '(.+)')
        .replace(/\\\*/g, '([^/]+)') +
      '$'
  );

  if (!fieldValue.match(regex)) {
    return undefined;
  }

  return encodeWithoutSlashes(fieldValue);
}

interface MatchResult {
  matchedFields: string[];
  url: string;
}

export function match(
  request: RequestType,
  pattern: string
): MatchResult | undefined {
  let url = pattern;
  const matchedFields = [];
  for (;;) {
    const match = url.match(/^(.*)\{([^}=]+)(?:=([^}]*))?\}(.*)/);
    if (!match) {
      break;
    }
    const [, before, field, pattern, after] = match;
    matchedFields.push(field);
    const fieldValue = getField(request, field);
    if (typeof fieldValue === 'undefined') {
      return undefined;
    }
    const appliedPattern = applyPattern(pattern, fieldValue.toString());
    if (typeof appliedPattern === 'undefined') {
      return undefined;
    }
    url = before + appliedPattern + after;
  }

  return {matchedFields, url};
}

export function flattenObject(request: RequestType): RequestType {
  const result: RequestType = {};
  for (const key in request) {
    if (typeof request[key] === 'undefined') {
      continue;
    }

    if (Array.isArray(request[key])) {
      // According to the http.proto comments, a repeated field may only
      // contain primitive types, so no extra recursion here.
      result[key] = request[key];
      continue;
    }

    if (typeof request[key] === 'object' && request[key] !== null) {
      const nested = flattenObject(request[key] as RequestType);
      for (const nestedKey in nested) {
        result[`${key}.${nestedKey}`] = nested[nestedKey];
      }
      continue;
    }

    result[key] = request[key];
  }

  return result;
}

export function transcode(
  request: RequestType,
  parsedOptions: ParsedOptionsType
): TranscodedRequest | undefined {
  const httpRules = [];
  for (const option of parsedOptions) {
    if (!(httpOptionName in option)) {
      continue;
    }

    const httpRule = option[httpOptionName] as google.api.IHttpRule;
    httpRules.push(httpRule);

    if (httpRule?.additional_bindings) {
      const additionalBindings = Array.isArray(httpRule.additional_bindings)
        ? httpRule.additional_bindings
        : [httpRule.additional_bindings];
      httpRules.push(...additionalBindings);
    }
  }

  for (const httpRule of httpRules) {
    for (const httpMethod of supportedHttpMethods) {
      if (!(httpMethod in httpRule)) {
        continue;
      }
      const pathTemplate = httpRule[
        httpMethod as keyof google.api.IHttpRule
      ] as string;
      const matchResult = match(request, pathTemplate);
      if (typeof matchResult === 'undefined') {
        continue;
      }
      const {url, matchedFields} = matchResult;

      if (httpRule.body === '*') {
        // all fields except the matched fields go to request data
        const data = deepCopy(request);
        for (const field of matchedFields) {
          deleteField(data, field);
        }
        return {httpMethod, url, queryString: '', data};
      }

      // one field possibly goes to request data, others go to query string
      const body = httpRule.body;
      let data: string | RequestType = '';
      const queryStringObject = deepCopy(request);
      if (body) {
        deleteField(queryStringObject, body);
        data = request[body] as RequestType;
      }
      for (const field of matchedFields) {
        deleteField(queryStringObject, field);
      }
      const queryStringComponents = buildQueryStringComponents(
        queryStringObject
      );
      const queryString = queryStringComponents.join('&');
      return {httpMethod, url, queryString, data};
    }
  }
  return undefined;
}
