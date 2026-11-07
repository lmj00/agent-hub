import { Type, type TSchema } from "@sinclair/typebox";
export const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
export const enumeration = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((value) => Type.Literal(value as T[number])));
export const text = Type.String();
export const id = Type.String({ format: "uuid" });
export const date = Type.String({ format: "date-time" });
export const requestKey = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: "^[A-Za-z0-9]",
  not: { pattern: "[^A-Za-z0-9._-]" },
});
