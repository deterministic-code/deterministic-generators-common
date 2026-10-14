import { describe, expect, test } from "vitest";
import { TypesValidator } from "./index.ts";
import { parseYamlWithPositions } from "./yamlPositions.ts";
import {
  checkFieldDefaultSemantics,
  checkFieldDefaults,
} from "./fieldDefaultSemantics.ts";
import { loadFieldTypeCatalog } from "./fieldTypeCatalog.ts";
import type { ParsedYaml } from "./SpecValidator.ts";

const validator = () => new TypesValidator();

function parsed(text: string): ParsedYaml {
  const { doc, lineCounter } = parseYamlWithPositions(text);
  return { doc, lineCounter, data: doc.toJS() };
}

function fieldDoc(type: string, defaultValue: string, extra = ""): string {
  return `version: 1.0.0
types:
  - t:
      fields:
        - a:
            type: ${type}
${extra}            default_value: ${defaultValue}
`;
}

async function validateField(
  type: string,
  defaultValue: string,
  extra = "",
) {
  return validator().validate(fieldDoc(type, defaultValue, extra));
}

describe("accepted default_value for every catalog type", () => {
  test.each([
    ["string", '""', "            size: 8\n"],
    ["string", "hello", "            size: 8\n"],
    ["character", "X"],
    ["character", "ABCD", "            size: 4\n"],
    ["number", "0"],
    ["number", "-3"],
    ["integer", "0"],
    ["integer", "-2147483648"],
    ["integer", "2147483647"],
    ["unsignedinteger", "0"],
    ["unsignedinteger", "4294967295"],
    ["biginteger", '"0"'],
    ["biginteger", '"-9223372036854775808"'],
    ["biginteger", '"9223372036854775807"'],
    ["unsignedbiginteger", '"0"'],
    ["unsignedbiginteger", '"18446744073709551615"'],
    ["smallinteger", "0"],
    ["smallinteger", "-32768"],
    ["smallinteger", "32767"],
    ["unsignedsmallinteger", "0"],
    ["unsignedsmallinteger", "65535"],
    ["float", "0"],
    ["float", "1.5"],
    ["float", "-2.25"],
    ["decimal", "0"],
    ["decimal", '"0.00"'],
    ["decimal", '"-12.5"'],
    ["boolean", "true"],
    ["boolean", "false"],
    ["datetime", "Now"],
    ["datetime", "UtcNow"],
    ["datetime", "\"DateTime('2026-01-01T00:00:00Z')\""],
    ["binary", "\"Hex('')\"", "            size: 4\n"],
    ["binary", "\"Hex('DEADBEEF')\"", "            size: 4\n"],
    ["uuid", "NewId"],
    ["uuid", "Empty"],
    ["uuid", "\"uuid('11111111-1111-4111-8111-111111111111')\""],
  ] as Array<[string, string, string?]>)(
    "%s default_value %s",
    async (type, defaultValue, extra) => {
      const result = await validateField(type, defaultValue, extra ?? "");
      expect(result, `${type} ${defaultValue}`).toEqual({
        valid: true,
        errors: [],
      });
    },
  );

  test("reference field with no default_value is valid", async () => {
    const result = await validator().validate(`version: 1.0.0
types:
  - t:
      fields:
        - parent_id:
            references: t.id
`);
    expect(result).toEqual({ valid: true, errors: [] });
  });
});

describe("rejected default_value — invalid token", () => {
  test.each([
    ["datetime", "whenever"],
    ["datetime", "\"2020-01-01T00:00:00Z\""],
    ["datetime", "\"DateTime('not-a-date')\""],
    ["uuid", "\"11111111-1111-4111-8111-111111111111\""],
    ["uuid", "not-a-uuid"],
    ["binary", '""'],
    ["binary", "\"Hex('GG')\""],
    ["binary", "\"Hex('ABC')\""],
    ["character", "AB"],
    ["decimal", "not_a_number"],
    ["biginteger", "nope"],
    ["unsignedbiginteger", '"-1"'],
  ])("%s default_value %s", async (type, defaultValue) => {
    const extra = type === "binary" ? "            size: 4\n" : "";
    const result = await validateField(type, defaultValue, extra);
    expect(result.valid, `${type} ${defaultValue}`).toBe(false);
  });
});

describe("rejected default_value — out of range", () => {
  test.each([
    ["smallinteger", "32768", "smallinteger", "-32768", "32767"],
    ["smallinteger", "-32769", "smallinteger", "-32768", "32767"],
    ["integer", "2147483648", "integer", "-2147483648", "2147483647"],
    ["integer", "-2147483649", "integer", "-2147483648", "2147483647"],
    ["unsignedinteger", "4294967296", "unsignedinteger", "0", "4294967295"],
    ["unsignedsmallinteger", "65536", "unsignedsmallinteger", "0", "65535"],
    [
      "biginteger",
      '"9223372036854775808"',
      "biginteger",
      "-9223372036854775808",
      "9223372036854775807",
    ],
    [
      "biginteger",
      '"-9223372036854775809"',
      "biginteger",
      "-9223372036854775808",
      "9223372036854775807",
    ],
    [
      "unsignedbiginteger",
      '"18446744073709551616"',
      "unsignedbiginteger",
      "0",
      "18446744073709551615",
    ],
  ])(
    "%s default_value %s",
    async (type, defaultValue, typeName, min, max) => {
      const result = await validateField(type, defaultValue);
      expect(result.valid, `${type} ${defaultValue}`).toBe(false);
      const message = result.errors[0]?.message ?? "";
      const raw = String(defaultValue).replace(/"/g, "");
      const semantic = `default_value '${raw}' is out of range for ${typeName} (allowed ${min}..${max})`;
      expect(
        message === semantic || /<=|>=|must be|maximum|minimum/.test(message),
        message,
      ).toBe(true);
    },
  );

  test("rejects a negative unsignedinteger as out of range", async () => {
    const result = await validateField("unsignedinteger", "-1");
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/out of range|must be|minimum/);
  });
});

describe("default_value on include combine_options field defs", () => {
  test("rejects a bad datetime token on modify_fields.def", async () => {
    const result = await validator().validate(`version: 1.0.0
includes:
  - file: other.yaml
    combine_options:
      source:
        modify_fields:
          - field: user.created_on
            def:
              type: datetime
              default_value: whenever
types: []
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.instancePath).toContain(
      "/includes/0/combine_options/source/modify_fields/0/def",
    );
  });

  test("rejects an out-of-range integer on add_fields", async () => {
    const result = await validator().validate(`version: 1.0.0
includes:
  - file: other.yaml
    combine_options:
      destination:
        add_fields:
          - type: user
            add_field:
              count:
                type: smallinteger
                default_value: 99999
types: []
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.instancePath).toContain(
      "/includes/0/combine_options/destination/add_fields/0/add_field/count",
    );
  });
});

describe("checkFieldDefaultSemantics", () => {
  test("loads the live catalog and accepts a document with no defaults", async () => {
    const result = await checkFieldDefaultSemantics(parsed("types: []\n"));
    expect(result).toEqual({ valid: true, errors: [] });
  });
});

describe("checkFieldDefaults", () => {
  test("reports allowed token names when a string default matches no regex", async () => {
    const catalog = await loadFieldTypeCatalog();
    const result = checkFieldDefaults(
      parsed(`version: 1.0.0
types:
  - t:
      fields:
        - a:
            type: datetime
            default_value: whenever
`),
      catalog,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toBe(
      "default_value 'whenever' is not a valid datetime default — allowed forms: Now, UtcNow, DateTime",
    );
  });

  test("skips fields without default_value or type", async () => {
    const catalog = await loadFieldTypeCatalog();
    const result = checkFieldDefaults(
      parsed(`version: 1.0.0
types:
  - t:
      fields:
        - a:
            type: datetime
        - b:
            references: t.id
`),
      catalog,
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("ignores malformed types/includes and unknown field types", async () => {
    const catalog = await loadFieldTypeCatalog();
    expect(
      checkFieldDefaults(parsed("[]"), catalog),
    ).toEqual({ valid: true, errors: [] });
    const result = checkFieldDefaults(
      parsed(`version: 1.0.0
types:
  - null
  - {}
  - t:
      fields: nope
  - u:
      fields:
        - null
        - {}
        - a: null
        - "":
            type: datetime
            default_value: Now
        - z:
            default_value: Now
        - n:
            type: 1
            default_value: Now
        - mystery:
            type: mystery
            default_value: Now
includes:
  - file: other.yaml
  - combine_options: {}
  - combine_options:
      source:
        modify_fields: nope
        add_fields: nope
  - combine_options:
      source:
        modify_fields:
          - {}
      destination:
        add_fields:
          - {}
          - add_field: {}
          - add_field:
              "":
                type: datetime
                default_value: Now
          - add_field:
              x: null
`),
      catalog,
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("applies one-sided numeric bounds and skips non-integer literals", () => {
    const catalog = new Map([
      [
        "lo",
        {
          name: "lo",
          min_value: "0",
          defaults: [],
        },
      ],
      [
        "hi",
        {
          name: "hi",
          max_value: "5",
          defaults: [],
        },
      ],
      [
        "open",
        {
          name: "open",
          min_value: null,
          max_value: null,
          defaults: [],
        },
      ],
    ]);
    const doc = parsed(`version: 1.0.0
types:
  - t:
      fields:
        - a:
            type: lo
            default_value: -1
        - b:
            type: hi
            default_value: 6
        - c:
            type: hi
            default_value: 1.5
        - d:
            type: open
            default_value: 99
        - e:
            type: lo
            default_value:
        - f:
            type: open
            default_value: x
        - g:
            type: lo
            default_value: 1
`);
    const fields = (
      doc.data as {
        types: Array<{ t: { fields: Array<Record<string, { default_value?: unknown }>> } }>;
      }
    ).types[0]!.t.fields;
    fields[fields.length - 1]!.g.default_value = undefined;
    const result = checkFieldDefaults(doc, catalog);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.message)).toEqual([
      "default_value '-1' is out of range for lo (allowed 0..undefined)",
      "default_value '6' is out of range for hi (allowed undefined..5)",
    ]);
  });
});
