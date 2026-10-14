import { parse } from "yaml";

type YamlLiteral = string | number | boolean | null;
type YamlMap = { readonly [key: string]: YamlValue };
type YamlValue = YamlLiteral | YamlValue[] | YamlMap;
type Named = { name: string; node: YamlNode };

const isMap = (v: YamlValue | undefined): v is YamlMap =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isString = (v: YamlValue | undefined): v is string => typeof v === "string";

const isFiniteNumber = (v: YamlValue | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

const isFiniteInt = (v: YamlValue | undefined): v is number =>
  isFiniteNumber(v) && Number.isInteger(v);

const isLiteral = (v: YamlValue | undefined): v is YamlLiteral =>
  v === null ||
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean";

/** Typed cursor over a YAML value. Missing keys are empty nodes, not throws. */
export type YamlNode = {
  readonly value: YamlValue | undefined;
  readonly path: string;
  readonly record: YamlMap | undefined;
  child: (key: string) => YamlNode;
  has: (key: string) => boolean;
  str: (key: string) => string | undefined;
  bool: (key: string) => boolean;
  finiteNumber: (key: string) => number | undefined;
  finiteInt: (key: string) => number | undefined;
  literal: (key: string) => YamlLiteral | undefined;
  strings: (key: string) => string[];
  items: () => YamlNode[];
  namedItems: () => Named[];
  namedList: (key: string) => Named[];
};

const yamlNode = (value: YamlValue | undefined, path = "$"): YamlNode => {
  const record = isMap(value) ? value : undefined;
  const at = (key: string) => record?.[key];
  const pick =
    <T extends YamlValue>(pred: (v: YamlValue | undefined) => v is T) =>
    (key: string): T | undefined => {
      const v = at(key);
      return pred(v) ? v : undefined;
    };
  const child = (key: string) => yamlNode(at(key), `${path}.${key}`);
  const items = () =>
    Array.isArray(value)
      ? value.map((item, i) => yamlNode(item, `${path}[${i}]`))
      : [];
  return {
    value,
    path,
    record,
    child,
    has: (key) =>
      record !== undefined && Object.prototype.hasOwnProperty.call(record, key),
    str: pick(isString),
    bool: (key) => at(key) === true,
    finiteNumber: pick(isFiniteNumber),
    finiteInt: pick(isFiniteInt),
    literal: pick(isLiteral),
    strings: (key) => {
      const v = at(key);
      return Array.isArray(v) ? v.filter(isString) : [];
    },
    items,
    namedItems: () =>
      items().flatMap((item) => {
        const [name, body] = Object.entries(item.record ?? {})[0] ?? [];
        return name === undefined
          ? []
          : [{ name, node: yamlNode(body, `${item.path}.${name}`) }];
      }),
    namedList: (key) => child(key).namedItems(),
  };
};

export const YamlNode = Object.assign(yamlNode, {
  fromYaml: (text: string, path = "$") =>
    yamlNode(parse(text) as YamlValue, path),
});
