export class StrictJsonError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseStrictJson(raw, { maxBytes = 1048576, maxDepth = 100 } = {}) {
  const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw);
  if (bytes.length > maxBytes) throw new StrictJsonError("message-too-large", `JSON exceeds ${maxBytes} bytes`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StrictJsonError("invalid-encoding", "JSON is not valid UTF-8");
  }
  let index = 0;

  function fail(code, message) {
    throw new StrictJsonError(code, `${message} at byte-compatible character offset ${index}`);
  }

  function whitespace() {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[index])) index += 1;
  }

  function string() {
    const start = index;
    index += 1;
    while (index < text.length) {
      const unit = text.charCodeAt(index);
      if (text[index] === '"') {
        index += 1;
        const value = JSON.parse(text.slice(start, index));
        for (let offset = 0; offset < value.length; offset += 1) {
          const code = value.charCodeAt(offset);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(offset + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) fail("non-ijson", "String contains an unpaired high surrogate");
            offset += 1;
          } else if (code >= 0xdc00 && code <= 0xdfff) fail("non-ijson", "String contains an unpaired low surrogate");
        }
        return value;
      }
      if (unit < 0x20) fail("invalid-json", "String contains an unescaped control character");
      if (text[index] === "\\") {
        index += 1;
        if (!/["\\/bfnrtu]/.test(text[index] ?? "")) fail("invalid-json", "String contains an invalid escape");
        if (text[index] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) fail("invalid-json", "String contains an invalid Unicode escape");
          index += 4;
        }
      }
      index += 1;
    }
    fail("invalid-json", "Unterminated string");
  }

  function number() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (!match) fail("invalid-json", "Invalid number");
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail("non-ijson", "Number is outside the finite IEEE 754 range");
    if (!/[.eE]/.test(match[0]) && !Number.isSafeInteger(value)) fail("non-ijson", "Integer is outside the interoperable exact range");
    return value;
  }

  function value(depth) {
    if (depth > maxDepth) fail("reference-depth-exceeded", `JSON nesting exceeds ${maxDepth}`);
    whitespace();
    if (text[index] === '"') return string();
    if (text[index] === "{") return object(depth + 1);
    if (text[index] === "[") return array(depth + 1);
    if (text.startsWith("true", index)) { index += 4; return true; }
    if (text.startsWith("false", index)) { index += 5; return false; }
    if (text.startsWith("null", index)) { index += 4; return null; }
    if (text[index] === "-" || /[0-9]/.test(text[index] ?? "")) return number();
    fail("invalid-json", "Expected a JSON value");
  }

  function object(depth) {
    const result = {};
    const keys = new Set();
    index += 1;
    whitespace();
    if (text[index] === "}") { index += 1; return result; }
    while (index < text.length) {
      if (text[index] !== '"') fail("invalid-json", "Expected an object member name");
      const key = string();
      if (keys.has(key)) fail("duplicate-key", `Duplicate object member ${JSON.stringify(key)}`);
      keys.add(key);
      whitespace();
      if (text[index] !== ":") fail("invalid-json", "Expected a colon");
      index += 1;
      Object.defineProperty(result, key, { value: value(depth), enumerable: true, configurable: true, writable: true });
      whitespace();
      if (text[index] === "}") { index += 1; return result; }
      if (text[index] !== ",") fail("invalid-json", "Expected a comma or closing brace");
      index += 1;
      whitespace();
    }
    fail("invalid-json", "Unterminated object");
  }

  function array(depth) {
    const result = [];
    index += 1;
    whitespace();
    if (text[index] === "]") { index += 1; return result; }
    while (index < text.length) {
      result.push(value(depth));
      whitespace();
      if (text[index] === "]") { index += 1; return result; }
      if (text[index] !== ",") fail("invalid-json", "Expected a comma or closing bracket");
      index += 1;
    }
    fail("invalid-json", "Unterminated array");
  }

  const parsed = value(0);
  whitespace();
  if (index !== text.length) fail("invalid-json", "Unexpected trailing content");
  return parsed;
}
