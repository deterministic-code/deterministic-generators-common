import { describe, expect, test } from "vitest";
import {
  FrontendBindingsValidator,
  RoutesValidator,
  ServicesValidator,
  TypesValidator,
} from "./index.ts";
import { checkRouteModel } from "./routeModelSemantics.ts";
import { checkServiceModel } from "./serviceModelSemantics.ts";
import { checkTypeModel } from "./typeModelSemantics.ts";
import { singleKey } from "./semanticsUtil.ts";
import { parseYamlWithPositions } from "./yamlPositions.ts";
import type { ParsedYaml } from "./SpecValidator.ts";

function parsed(text: string): ParsedYaml {
  const { doc, lineCounter } = parseYamlWithPositions(text);
  return { doc, lineCounter, data: doc.toJS() };
}

describe("unique names and exclusive route dispatch", () => {
  test("rejects duplicate view names", async () => {
    const result = await new TypesValidator().validate(`version: 1.0.0
types:
  - person:
      fields:
        - n:
            type: integer
  - person:
      fields:
        - n:
            type: integer
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toBe("duplicate type 'person'");
  });

  test("rejects duplicate route names", async () => {
    const result = await new RoutesValidator().validate(`version: 1.0.0
routes:
  - health:
      path: /api/health
      method: GET
      response: health
  - health:
      path: /api/ready
      method: GET
      response: health
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toBe("duplicate route 'health'");
  });

  test("rejects a custom route that combines dispatch styles", async () => {
    const result = await new RoutesValidator().validate(`version: 1.0.0
routes:
  - custom_post:
      path: /api/people
      method: POST
      response: person
      service: PersonService
      services: [AuditService]
      routeClass: PatchPersonRoute
      module: ./routes/patch-person
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(
      /cannot combine service and services and routeClass\/module/,
    );
  });

  test("rejects duplicate service names", async () => {
    const result = await new ServicesValidator().validate(`version: 1.0.0
services:
  - name: PersonService
    description: a
  - name: PersonService
    description: b
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toBe("duplicate service 'PersonService'");
  });

  test("rejects REST paired with a GraphQL schema_type", async () => {
    const result = await new FrontendBindingsValidator().validate(`version: 1.0.0
datasources:
  - core:
      type: REST
      schema_type: GraphQL
      schema: https://example.com/openapi.json
`);
    expect(result.valid).toBe(false);
  });

  test("rejects a schema location that is not https / file: / id:", async () => {
    const result = await new FrontendBindingsValidator().validate(`version: 1.0.0
datasources:
  - core:
      type: REST
      schema_type: OpenAPI
      schema: ./openapi.json
`);
    expect(result.valid).toBe(false);
  });

  test("rejects duplicate string-shorthand route names", async () => {
    const result = await new RoutesValidator().validate(`version: 1.0.0
routes:
  - get_users_by_email
  - get_users_by_email
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toBe("duplicate route 'get_users_by_email'");
  });

  test("model checks skip missing or malformed entries", () => {
    expect(checkRouteModel(parsed("version: 1.0.0\n")).valid).toBe(true);
    expect(
      checkRouteModel(parsed("version: 1.0.0\nroutes:\n  - []\n  - {}\n")).valid,
    ).toBe(true);
    expect(checkServiceModel(parsed("version: 1.0.0\n")).valid).toBe(true);
    expect(
      checkServiceModel(
        parsed("version: 1.0.0\nservices:\n  - []\n  - name: \"\"\n"),
      ).valid,
    ).toBe(true);
    expect(checkTypeModel(parsed("version: 1.0.0\n")).valid).toBe(true);
    expect(
      checkTypeModel(parsed("version: 1.0.0\ntypes:\n  - []\n  - {}\n")).valid,
    ).toBe(true);
    expect(singleKey(null)).toBeNull();
    expect(singleKey({})).toBeNull();
  });
});
