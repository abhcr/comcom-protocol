import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function ipv4Parts(address) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function publicIpv4(address) {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Parts(address) {
  let source = address.toLowerCase().split("%")[0];
  let ipv4;
  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    ipv4 = ipv4Parts(source.slice(lastColon + 1));
    if (!ipv4) return null;
    source = `${source.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const zeros = 8 - left.length - right.length;
  if ((halves.length === 1 && zeros !== 0) || zeros < 0) return null;
  const parts = [...left, ...Array(zeros).fill("0"), ...right];
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map(part => Number.parseInt(part, 16));
}

function publicIpv6(address) {
  const parts = ipv6Parts(address);
  if (!parts) return false;
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = parts;
  if (parts.every(part => part === 0) || parts.slice(0, 7).every(part => part === 0) && eighth === 1) return false;
  if (parts.slice(0, 5).every(part => part === 0) && sixth === 0xffff) {
    return publicIpv4(`${seventh >> 8}.${seventh & 255}.${eighth >> 8}.${eighth & 255}`);
  }
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false;
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && second <= 0x01ff) return false;
  if (first === 0x2001 && second === 0x0db8) return false;
  if (first === 0x2002) return false;
  if (first === 0x0064 && second === 0xff9b) return false;
  return true;
}

export function isPublicAddress(address) {
  const plain = address.replace(/^\[|\]$/g, "").split("%")[0];
  return isIP(plain) === 4 ? publicIpv4(plain) : isIP(plain) === 6 ? publicIpv6(plain) : false;
}

function loopbackAddress(address) {
  const plain = address.replace(/^\[|\]$/g, "");
  return plain === "::1" || plain.startsWith("127.");
}

function parseUrl(value, allowInsecureLoopback) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeUrlError("malformed-url", "URL is malformed");
  }
  if (url.username || url.password) throw new UnsafeUrlError("url-credentials-forbidden", "URL credentials are forbidden");
  if (url.hash) throw new UnsafeUrlError("url-fragment-forbidden", "URL fragments are forbidden");
  if (!url.hostname || url.hostname.endsWith(".")) throw new UnsafeUrlError("malformed-host", "URL host is malformed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const development = url.protocol === "http:" && allowInsecureLoopback && (host === "localhost" || loopbackAddress(host));
  if (url.protocol !== "https:" && !development) throw new UnsafeUrlError("unsafe-scheme", "Conformant retrieval requires HTTPS");
  return { url, development };
}

async function addressesFor(hostname, resolver) {
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal)) return [{ address: literal, family: isIP(literal) }];
  const records = await resolver(literal, { all: true, verbatim: true });
  if (!records.length) throw new UnsafeUrlError("dns-empty", "Host has no resolved addresses");
  return records;
}

export async function secureFetch(urlValue, options = {}) {
  const controller = new AbortController();
  const timeoutError = new UnsafeUrlError("fetch-timeout", "Retrieval exceeded the total timeout");
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, options.timeoutMs ?? 10_000);
  });
  const maxRedirects = options.maxRedirects ?? 3;
  const maxBytes = options.maxBytes ?? 1_048_576;
  const resolver = options.resolver ?? dnsLookup;
  let current = urlValue;
  let redirects = 0;
  let nonConformantDevelopment = false;

  try {
    while (true) {
      const parsed = parseUrl(current, options.allowInsecureLoopback === true);
      nonConformantDevelopment ||= parsed.development;
      const hostname = parsed.url.hostname.replace(/^\[|\]$/g, "");
      const records = await Promise.race([addressesFor(hostname, resolver), timeout]);
      if (!parsed.development && records.some(record => !isPublicAddress(record.address))) throw new UnsafeUrlError("unsafe-address", "Host resolves to a non-public address");
      if (parsed.development && records.some(record => !loopbackAddress(record.address))) throw new UnsafeUrlError("unsafe-address", "Development HTTP is limited to loopback addresses");
      const pinned = records[0];

      const response = await Promise.race([new Promise((resolveResponse, reject) => {
        const transport = parsed.url.protocol === "https:" ? https : http;
        const request = transport.request(parsed.url, {
          method: options.method ?? "GET",
          headers: options.headers,
          signal: controller.signal,
          servername: isIP(hostname) ? undefined : hostname,
          lookup: (_host, lookupOptions, callback) => lookupOptions.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family)
        }, responseValue => {
          const chunks = [];
          let bytes = 0;
          responseValue.on("data", chunk => {
            bytes += chunk.length;
            if (bytes > maxBytes) request.destroy(new UnsafeUrlError("response-too-large", `Response exceeds ${maxBytes} bytes`));
            else chunks.push(chunk);
          });
          responseValue.on("error", reject);
          responseValue.on("end", () => resolveResponse({ status: responseValue.statusCode, headers: responseValue.headers, body: Buffer.concat(chunks) }));
        });
        request.on("socket", socket => socket.once("connect", () => {
          const remote = socket.remoteAddress?.replace(/^::ffff:/, "");
          const expected = pinned.address.replace(/^::ffff:/, "");
          if (remote !== expected) request.destroy(new UnsafeUrlError("dns-rebinding", "Connected address differs from the pinned DNS result"));
          else if (!parsed.development && !isPublicAddress(socket.remoteAddress)) request.destroy(new UnsafeUrlError("unsafe-address", "Connected address is not public"));
        }));
        request.on("error", reject);
        request.end();
      }), timeout]);

      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        if (redirects >= maxRedirects) throw new UnsafeUrlError("redirect-limit", `Retrieval exceeds ${maxRedirects} redirects`);
        current = new URL(response.headers.location, parsed.url).href;
        redirects += 1;
        continue;
      }
      return { ...response, url: parsed.url.href, redirects, conformant: !nonConformantDevelopment };
    }
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
