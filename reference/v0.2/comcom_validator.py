#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import rfc8785
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_BASE = "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/schemas/"
DISCOVERY_SCHEMA_BASE = "https://abhcr.github.io/comcom-protocol/releases/v0.2.1/schemas/"
MANIFEST_SCHEMAS = {
    "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/profiles/manifest": SCHEMA_BASE + "manifest.schema.json",
    "https://abhcr.github.io/comcom-protocol/releases/v0.2.1/profiles/manifest": DISCOVERY_SCHEMA_BASE + "manifest.schema.json",
}
OFFICIAL_DIALECT = "https://json-schema.org/draft/2020-12/schema"


class StrictJsonError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def parse_strict_json(raw: bytes, max_bytes: int = 1_048_576, max_depth: int = 100):
    if len(raw) > max_bytes:
        raise StrictJsonError("message-too-large", f"JSON exceeds {max_bytes} bytes")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise StrictJsonError("invalid-encoding", "JSON is not valid UTF-8") from error

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise StrictJsonError("duplicate-key", f"Duplicate object member {key!r}")
            result[key] = value
        return result

    def integer(value):
        parsed = int(value)
        if abs(parsed) > 9_007_199_254_740_991:
            raise StrictJsonError("non-ijson", "Integer is outside the interoperable exact range")
        return parsed

    def floating(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            raise StrictJsonError("non-ijson", "Number is outside the finite IEEE 754 range")
        return parsed

    try:
        value = json.loads(
            text,
            object_pairs_hook=pairs,
            parse_int=integer,
            parse_float=floating,
            parse_constant=lambda value: (_ for _ in ()).throw(StrictJsonError("non-ijson", f"{value} is not I-JSON")),
        )
    except StrictJsonError:
        raise
    except json.JSONDecodeError as error:
        raise StrictJsonError("invalid-json", error.msg) from error

    def inspect(item, depth=0):
        if depth > max_depth:
            raise StrictJsonError("reference-depth-exceeded", f"JSON nesting exceeds {max_depth}")
        if isinstance(item, str):
            if any(0xD800 <= ord(character) <= 0xDFFF for character in item):
                raise StrictJsonError("non-ijson", "String contains an unpaired Unicode surrogate")
        elif isinstance(item, list):
            for child in item:
                inspect(child, depth + 1)
        elif isinstance(item, dict):
            for key, child in item.items():
                inspect(key, depth + 1)
                inspect(child, depth + 1)

    inspect(value)
    return value


def verdict_valid(value=None, **extra):
    return {"valid": True, "phase": "complete", "code": "valid", "errors": [], "value": value, **extra}


def verdict_invalid(phase, code, message, status=400, errors=None):
    return {
        "valid": False,
        "phase": phase,
        "code": code,
        "status": status,
        "errors": errors or [{"path": "/", "message": message}],
    }


def normalized_errors(errors):
    normalized = []
    for error in errors:
        path = "/" + "/".join(str(part).replace("~", "~0").replace("/", "~1") for part in error.absolute_path)
        normalized.append({"path": path, "keyword": error.validator, "message": error.message})
    return normalized


def semantic_projection(message):
    projection = {
        "capability": message["capability"],
        "principal": message["principal"],
        "recipient": message["recipient"],
    }
    for name in ("authorization", "resource"):
        if name in message:
            projection[name] = message[name]
    projection["payload"] = message["payload"]
    if message.get("criticalExtensions"):
        projection["criticalExtensions"] = {
            name: message["extensions"][name] for name in sorted(message["criticalExtensions"])
        }
    return projection


def semantic_hash(message):
    return hashlib.sha256(rfc8785.dumps(semantic_projection(message))).hexdigest()


class Protocol:
    def __init__(self):
        releases = {}
        for version in ("v0.2.0", "v0.2.1"):
            manifest = json.loads((ROOT / f"releases/{version}/release-manifest.json").read_text())
            tree = hashlib.sha256("".join(f"{file['path']}\0{file['sha256']}\n" for file in manifest["files"]).encode()).hexdigest()
            if tree != manifest["treeSha256"]:
                raise StrictJsonError("digest-mismatch", f"{version} release tree digest does not match")
            releases[version] = (manifest, {file["path"]: file for file in manifest["files"]})

        def verified_json(path, version, release_path):
            data = path.read_bytes()
            expected = releases[version][1].get(release_path)
            if not expected or len(data) != expected["bytes"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
                raise StrictJsonError("digest-mismatch", f"{release_path} does not match the {version} release manifest")
            return json.loads(data)

        paths = sorted((ROOT / "schemas/v0.2").glob("*.json"))
        paths += sorted((ROOT / "schemas/v0.2.1").glob("*.json"))
        paths += sorted((ROOT / "profiles/v0.2").glob("**/*.schema.json"))
        schemas = []
        registry = Registry()
        for path in paths:
            source = path.relative_to(ROOT).as_posix()
            version = "v0.2.1" if source.startswith("schemas/v0.2.1/") else "v0.2.0"
            release_path = "schemas/" + path.name if source.startswith("schemas/") else source
            schema = verified_json(path, version, release_path)
            schema["$schema"] = OFFICIAL_DIALECT
            schemas.append(schema)
            registry = registry.with_resource(schema["$id"], Resource.from_contents(schema, default_specification=DRAFT202012))
        checker = FormatChecker()
        self.validators = {
            schema["$id"]: Draft202012Validator(schema, registry=registry, format_checker=checker)
            for schema in schemas
        }
        self.registry = verified_json(ROOT / "registry/v0.2/capabilities.json", "v0.2.0", "registry.json")
        self.capabilities = {capability["id"]: capability for capability in self.registry["capabilities"]}
        self.release_manifest, self.release_files = releases["v0.2.0"]

    @staticmethod
    def _raw(raw, max_bytes=1_048_576):
        try:
            return parse_strict_json(raw, max_bytes), None
        except StrictJsonError as error:
            return None, verdict_invalid("raw", error.code, str(error), 413 if error.code == "message-too-large" else 400)

    def _schema(self, schema_id, value, phase="envelope"):
        errors = sorted(self.validators[schema_id].iter_errors(value), key=lambda error: list(error.absolute_path))
        if errors:
            return verdict_invalid(phase, "schema-invalid", f"Invalid {phase}", 422 if phase == "payload" else 400, normalized_errors(errors))
        return None

    @staticmethod
    def _security_satisfied(requirements, context):
        scheme = context.get("scheme", [])
        active = set(scheme if isinstance(scheme, list) else [scheme] if scheme else [])
        scopes = set(context.get("scopes", []))
        return any(not requirement or all(name in active and set(required).issubset(scopes) for name, required in requirement.items()) for requirement in requirements or [])

    @staticmethod
    def _extensions(message, supported):
        for name in message.get("criticalExtensions", []):
            if name not in message.get("extensions", {}):
                return verdict_invalid("extensions", "malformed-critical-extension", f"Critical extension {name} is not present")
            if name not in supported:
                return verdict_invalid("extensions", "unsupported-critical-extension", f"Critical extension {name} is not supported", 422)
        return None

    @staticmethod
    def _timing(message, context):
        now = datetime.fromisoformat(context["now"].replace("Z", "+00:00")) if context.get("now") else datetime.now(timezone.utc)
        issued = datetime.fromisoformat(message["issuedAt"].replace("Z", "+00:00"))
        if (issued - now).total_seconds() > 60:
            return verdict_invalid("expiry", "issued-at-in-future", "issuedAt exceeds the 60-second clock tolerance", 412)
        if message.get("expiresAt"):
            expires = datetime.fromisoformat(message["expiresAt"].replace("Z", "+00:00"))
            if expires < now and not context.get("recordedReplay"):
                return verdict_invalid("expiry", "message-expired", "The first-seen message has expired", 412)
            if expires < issued:
                return verdict_invalid("expiry", "expiry-before-issuance", "expiresAt precedes issuedAt")
        return None

    def validate_discovery(self, raw, context):
        if context.get("method") == "HEAD" and not raw:
            if context.get("contentType") != "application/linkset+json":
                return verdict_invalid("discovery", "content-type-mismatch", "RFC 9727 discovery requires application/linkset+json", 415)
            return verdict_valid()
        value, failure = self._raw(raw, 65_536)
        if failure:
            return failure
        if context.get("method") and context["method"] not in ("GET", "HEAD"):
            return verdict_invalid("discovery", "method-not-allowed", "Discovery supports GET and HEAD", 405)
        if context.get("contentType") and context["contentType"].split(";")[0].strip() != "application/linkset+json":
            return verdict_invalid("discovery", "content-type-mismatch", "RFC 9727 discovery requires application/linkset+json", 415)
        failure = self._schema(DISCOVERY_SCHEMA_BASE + "discovery.schema.json", value, "discovery")
        if failure:
            return failure
        if any(not item["href"].startswith("https://") for group in value["linkset"] for item in group["item"]):
            return verdict_invalid("discovery", "unsafe-url", "Manifest links must use HTTPS")
        if any(not group["anchor"].startswith("https://") for group in value["linkset"]):
            return verdict_invalid("discovery", "unsafe-url", "Discovery anchors must use HTTPS")
        return verdict_valid(value)

    def validate_manifest(self, raw, context=None):
        context = context or {}
        profile = context.get("manifestProfile", "https://abhcr.github.io/comcom-protocol/releases/v0.2.0/profiles/manifest")
        schema = MANIFEST_SCHEMAS.get(profile) if isinstance(profile, str) else None
        if not schema:
            return verdict_invalid("manifest", "unsupported-manifest-profile", "manifestProfile must identify a supported pinned manifest profile")
        value, failure = self._raw(raw)
        if failure:
            return failure
        failure = self._schema(schema, value, "manifest")
        if failure:
            return failure
        if "discoveryPublisher" in value["roles"]:
            return verdict_valid(value)
        profiles = {profile["id"] for profile in value["profiles"]}
        schemes = set(value.get("securitySchemes", {}))
        for profile in value["profiles"]:
            path = f"profiles/{profile['id']}.bundle.json"
            expected = self.release_files.get(path)
            if not expected or profile["release"] != f"https://abhcr.github.io/comcom-protocol/releases/v0.2.0/{path}" or profile["sha256"] != expected["sha256"]:
                return verdict_invalid("manifest", "profile-digest-mismatch", f"{profile['id']} does not identify the verified profile bundle")
        declarations = set()
        for declaration in value["capabilities"]:
            capability = self.capabilities.get(declaration["id"])
            declaration_key = (declaration["id"], declaration["version"], declaration["direction"])
            if declaration_key in declarations:
                return verdict_invalid("manifest", "duplicate-capability-declaration", f"{declaration['id']} is declared twice in the same direction")
            declarations.add(declaration_key)
            if not capability or capability["version"] != declaration["version"]:
                return verdict_invalid("manifest", "unsupported-capability", f"{declaration['id']} is not in the verified release")
            if declaration["profile"] not in profiles or declaration["profile"] != capability["profile"]:
                return verdict_invalid("manifest", "profile-mismatch", f"{declaration['id']} is assigned to a different profile")
            if declaration["kinds"] != [capability["requestKind"]]:
                return verdict_invalid("manifest", "message-kind-mismatch", f"{declaration['id']} must declare only its registered request kind")
            if declaration["inputSchema"] != capability["schemas"]["input"] or declaration["outputSchema"] != capability["schemas"]["output"]:
                return verdict_invalid("manifest", "profile-schema-mismatch", f"{declaration['id']} schema identifiers differ from the verified profile")
            if any(mode not in capability["executionModes"] for mode in declaration["executionModes"]):
                return verdict_invalid("manifest", "execution-mode-mismatch", f"{declaration['id']} advertises an unsupported execution mode")
            role = "inboxReceiver" if "event" in declaration["kinds"] else "responder"
            if declaration["direction"] == "receive" and role not in value["roles"]:
                return verdict_invalid("role", "role-mismatch", f"{declaration['id']} receipt requires {role}")
            if declaration["direction"] == "send" and "initiator" not in value["roles"]:
                return verdict_invalid("role", "role-mismatch", f"{declaration['id']} sending requires initiator")
            if declaration["direction"] == "receive" and "asynchronous" in declaration["executionModes"] and "asyncResponder" not in value["roles"]:
                return verdict_invalid("role", "role-mismatch", f"{declaration['id']} asynchronous receipt requires asyncResponder")
            for form in declaration.get("forms", []):
                if form["executionMode"] not in declaration["executionModes"]:
                    return verdict_invalid("manifest", "execution-mode-mismatch", f"{form['executionMode']} is not declared for {declaration['id']}")
                if not any(form["href"] == origin or form["href"].startswith(origin + "/") for origin in value["serviceOrigins"]):
                    return verdict_invalid("endpoint", "endpoint-origin-mismatch", f"{form['href']} is outside serviceOrigins")
                for requirement in form["security"]:
                    for name, scopes in requirement.items():
                        if name not in schemes:
                            return verdict_invalid("security", "unknown-security-scheme", f"{name} is not declared")
                        if value["securitySchemes"][name]["type"] not in ("oauth2", "openIdConnect") and scopes:
                            return verdict_invalid("security", "invalid-security-scopes", f"{name} cannot declare OAuth scopes")
                if "command" in declaration["kinds"] and not declaration.get("anonymousCommand") and any(not requirement for requirement in form["security"]):
                    return verdict_invalid("security", "anonymous-command-forbidden", f"{declaration['id']} does not explicitly permit anonymous commands")
            if declaration["direction"] == "receive" and declaration["kinds"][0] == "event" and not any(declaration["id"] in admission["capabilities"] for admission in value.get("inbox", {}).get("admissions", [])):
                return verdict_invalid("manifest", "inbox-admission-missing", f"{declaration['id']} has no exact inbox admission")
        for origin in value["serviceOrigins"]:
            parsed = urlsplit(origin)
            if parsed.scheme != "https" or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
                return verdict_invalid("manifest", "unsafe-url", f"{origin} is not an HTTPS origin")
        return verdict_valid(value)

    def validate_request(self, raw, context):
        message, failure = self._raw(raw, context.get("maxBytes", 1_048_576))
        if failure:
            return failure
        if not isinstance(message, dict) or message.get("protocolVersion") != "0.2":
            return verdict_invalid("protocol", "protocol-version-mismatch", "protocolVersion must be 0.2")
        failure = self._schema(SCHEMA_BASE + "envelope.schema.json", message)
        if failure:
            return failure
        capability = self.capabilities.get(message["capability"]["id"])
        if not capability or capability["version"] != message["capability"]["version"]:
            return verdict_invalid("capability", "capability-version-mismatch", "Capability ID and exact SemVer are not in the release", 422)
        if message["kind"] != capability["requestKind"]:
            return verdict_invalid("capability", "message-kind-mismatch", f"Expected {capability['requestKind']}, received {message['kind']}", 422)
        manifest = context.get("manifest")
        if not manifest:
            return verdict_invalid("direction", "manifest-required", "Request validation requires the receiver manifest")
        declaration = next((item for item in manifest["capabilities"] if item["id"] == capability["id"] and item["version"] == capability["version"] and item["direction"] == "receive"), None)
        if not declaration:
            return verdict_invalid("direction", "direction-mismatch", "Capability is not advertised for receipt", 404)
        if message["kind"] not in declaration["kinds"]:
            return verdict_invalid("capability", "message-kind-mismatch", "Manifest does not accept this message kind", 422)
        if declaration["inputSchema"] != capability["schemas"]["input"] or declaration["outputSchema"] != capability["schemas"]["output"]:
            return verdict_invalid("capability", "profile-schema-mismatch", "Manifest schemas differ from the verified profile", 422)
        role = "inboxReceiver" if message["kind"] == "event" else "responder"
        if role not in manifest["roles"]:
            return verdict_invalid("role", "role-mismatch", f"Receipt requires {role}", 403)
        if message["recipient"]["id"] != manifest["entity"]["id"]:
            return verdict_invalid("recipient", "recipient-mismatch", "Message recipient does not match the receiving manifest", 403)
        transport = context.get("transport", {})
        if not transport.get("senderId") or message["sender"]["id"] != transport["senderId"]:
            return verdict_invalid("identity", "sender-identity-mismatch", "Authenticated transport sender does not match message.sender.id", 403)
        endpoint = context.get("endpoint", {})
        form = next((form for form in declaration.get("forms", []) if (not endpoint.get("url") or form["href"] == endpoint["url"]) and (not endpoint.get("method") or form["method"] == endpoint["method"])), None)
        if not form:
            return verdict_invalid("endpoint", "endpoint-mismatch", "Request was not delivered to a declared form", 404)
        requirements = form.get("security") or manifest.get("security")
        if not requirements or not self._security_satisfied(requirements, transport):
            return verdict_invalid("security", "security-requirement-unsatisfied", "No OpenAPI security requirement alternative is satisfied", 401)
        failure = self._extensions(message, context.get("supportedExtensions", []))
        if failure:
            return failure
        failure = self._schema(capability["schemas"]["input"], message["payload"], "payload")
        if failure:
            return failure
        failure = self._timing(message, context)
        return failure or verdict_valid(message, capability=capability, declaration=declaration, form=form)

    def validate_response(self, raw, context):
        message, failure = self._raw(raw, context.get("maxBytes", 1_048_576))
        if failure:
            return failure
        if not isinstance(message, dict) or message.get("protocolVersion") != "0.2":
            return verdict_invalid("protocol", "protocol-version-mismatch", "protocolVersion must be 0.2")
        failure = self._schema(SCHEMA_BASE + "envelope.schema.json", message)
        if failure:
            return failure
        request = context.get("request")
        if not request:
            return verdict_invalid("response", "request-context-required", "Response validation requires the original request")
        capability = self.capabilities.get(request["capability"]["id"])
        if not capability or message["capability"] != request["capability"]:
            return verdict_invalid("capability", "capability-version-mismatch", "Response capability differs from the request", 422)
        expected = "receipt" if request["kind"] == "event" else "result"
        if message["kind"] != expected:
            return verdict_invalid("response", "response-kind-mismatch", f"Expected {expected}, received {message['kind']}", 422)
        if message["correlationId"] != request["id"]:
            return verdict_invalid("correlation", "correlation-mismatch", "Response correlationId does not equal the request id", 422)
        if message["recipient"]["id"] != request["sender"]["id"] or message["sender"]["id"] != request["recipient"]["id"]:
            return verdict_invalid("recipient", "recipient-mismatch", "Response participants do not reverse the request participants", 403)
        if not context.get("transport", {}).get("senderId") or message["sender"]["id"] != context["transport"]["senderId"]:
            return verdict_invalid("identity", "sender-identity-mismatch", "Authenticated responder does not match message.sender.id", 403)
        failure = self._extensions(message, context.get("supportedExtensions", []))
        if failure:
            return failure
        operation_payload = message["kind"] == "result" and isinstance(message["payload"], dict) and "statusUrl" in message["payload"] and "state" in message["payload"]
        if operation_payload:
            failure = self._schema(SCHEMA_BASE + "operation.schema.json", message["payload"], "payload")
            if failure:
                return failure
            if message["payload"]["state"] == "completed":
                failure = self._schema(capability["schemas"]["output"], message["payload"]["output"], "payload")
                if failure:
                    return failure
        else:
            failure = self._schema(capability["schemas"]["output"], message["payload"], "payload")
            if failure:
                return failure
        failure = self._timing(message, context)
        return failure or verdict_valid(message, capability=capability)

    def validate_release_bundle(self, raw, context):
        value, failure = self._raw(raw, 16_777_216)
        if failure:
            failure["phase"] = "bundle"
            return failure
        failure = self._schema(SCHEMA_BASE + "release-manifest.schema.json", value, "bundle")
        if failure:
            return failure
        for file in value["files"]:
            supplied = context.get("files", {}).get(file["path"])
            if supplied is None:
                return verdict_invalid("bundle", "bundle-file-missing", f"{file['path']} is missing")
            data = __import__("base64").b64decode(supplied) if context.get("filesEncoding") == "base64" else supplied.encode()
            if len(data) != file["bytes"] or hashlib.sha256(data).hexdigest() != file["sha256"]:
                return verdict_invalid("bundle", "digest-mismatch", f"{file['path']} does not match its recorded digest")
        tree = hashlib.sha256("".join(f"{file['path']}\0{file['sha256']}\n" for file in value["files"]).encode()).hexdigest()
        if tree != value["treeSha256"]:
            return verdict_invalid("bundle", "digest-mismatch", "Release tree digest does not match")
        return verdict_valid(value)


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    incoming = sys.stdin.buffer.read()
    separator = incoming.find(b"\n\n")
    if separator < 0:
        print(json.dumps(verdict_invalid("raw", "cli-input-invalid", "stdin must contain context JSON, a blank line, then raw document bytes"), separators=(",", ":")))
        return 1
    try:
        context = parse_strict_json(incoming[:separator])
    except StrictJsonError as error:
        print(json.dumps(verdict_invalid("raw", error.code, str(error)), separators=(",", ":")))
        return 1
    raw = incoming[separator + 2:]
    try:
        protocol = Protocol()
    except StrictJsonError as error:
        print(json.dumps(verdict_invalid("bundle", error.code, str(error)), separators=(",", ":")))
        return 1
    commands = {
        "request": protocol.validate_request,
        "response": protocol.validate_response,
        "discovery": protocol.validate_discovery,
        "manifest": protocol.validate_manifest,
        "release-bundle": protocol.validate_release_bundle,
    }
    if command not in commands:
        result = verdict_invalid("raw", "cli-command-invalid", "command must be request, response, discovery, manifest, or release-bundle")
    else:
        result = commands[command](raw, context)
    for name in ("value", "capability", "declaration", "form"):
        result.pop(name, None)
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
