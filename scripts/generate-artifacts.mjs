import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const canonicalBase = "https://abhcr.github.io/comcom-protocol";
const protocolVersion = "0.1";

const groups = {
  identity: [
    "entity.profile.get", "entity.profile.publish", "directory.search", "relationship.request",
    "relationship.accept", "relationship.end", "identity.verify", "contact.preferences.get"
  ],
  catalog: [
    "catalog.list", "catalog.get", "catalog.search", "catalog.subscribe", "product.get",
    "product.search", "product.compare", "product.sample.request", "product.customize.request",
    "product.recommendations.get"
  ],
  services: [
    "service.list", "service.get", "service.search", "service.requirements.get",
    "service.estimate.request", "service.engagement.start", "service.progress.get",
    "service.completion.accept"
  ],
  scheduling: [
    "availability.check", "availability.calendar.get", "slot.hold", "slot.release",
    "appointment.create", "appointment.get", "appointment.reschedule", "appointment.cancel",
    "appointment.checkin", "appointment.complete"
  ],
  pricing: [
    "price.get", "rate.list", "discount.eligibility.check", "quote.request", "quote.get",
    "quote.accept", "quote.reject", "offer.publish", "offer.receive", "offer.withdraw"
  ],
  procurement: [
    "rfq.publish", "rfq.respond", "tender.publish", "tender.question.submit",
    "tender.bid.submit", "tender.bid.withdraw", "tender.award.publish", "supplier.qualify",
    "purchase.requisition.submit"
  ],
  orders: [
    "order.create", "order.get", "order.list", "order.change", "order.cancel", "order.approve",
    "order.reject", "order.acknowledge", "order.fulfillment.get", "order.complete"
  ],
  booking: [
    "booking.create", "booking.get", "booking.modify", "booking.cancel", "room.search",
    "room.book", "flight.search", "flight.book", "journey.itinerary.get", "event.search",
    "event.register", "ticket.issue"
  ],
  operations: [
    "inventory.check", "inventory.reserve", "inventory.release", "inventory.adjust",
    "replenishment.request", "production.order.create", "production.status.get", "asset.register",
    "asset.assign", "asset.maintenance.request"
  ],
  logistics: [
    "shipment.quote.request", "shipment.create", "shipment.get", "shipment.track",
    "shipment.cancel", "pickup.schedule", "pickup.confirm", "dispatch.notify",
    "delivery.estimate.get", "delivery.confirm", "receipt.acknowledge", "proof.of.delivery.get"
  ],
  finance: [
    "invoice.issue", "invoice.receive", "invoice.get", "invoice.dispute", "credit.note.issue",
    "payment.request", "payment.status.get", "payment.confirm", "refund.request",
    "refund.status.get", "account.statement.get", "reconciliation.submit"
  ],
  support: [
    "return.request", "return.authorize", "return.status.get", "exchange.request",
    "warranty.check", "warranty.claim", "support.case.create", "support.case.get",
    "complaint.submit", "dispute.resolve"
  ],
  subscriptions: [
    "subscription.create", "subscription.get", "subscription.change", "subscription.pause",
    "subscription.resume", "subscription.cancel", "membership.join", "membership.leave"
  ],
  communications: [
    "announcement.receive", "announcement.publish", "reminder.receive", "alert.receive",
    "notification.preferences.get", "notification.preferences.update", "message.send",
    "message.acknowledge", "survey.submit", "review.publish"
  ],
  data: [
    "consent.request", "consent.grant", "consent.revoke", "data.access.request",
    "data.export.request", "data.correction.request", "data.deletion.request",
    "permission.grant", "permission.revoke", "license.issue"
  ],
  trust: [
    "credential.issue", "credential.present", "credential.verify", "certificate.issue",
    "permit.apply", "permit.status.get", "contract.propose", "contract.accept",
    "contract.terminate", "compliance.report.submit"
  ],
  workforce: [
    "job.publish", "job.apply", "candidate.status.get", "interview.schedule", "employment.offer",
    "employee.onboard", "shift.get", "shift.swap.request", "leave.request", "employee.offboard"
  ],
  social: [
    "healthcare.provider.search", "healthcare.service.request", "healthcare.referral.submit",
    "prescription.fulfillment.get", "education.course.search", "education.enroll",
    "education.progress.get", "assessment.submit", "certificate.verify", "research.data.request"
  ],
  publicServices: [
    "government.service.search", "government.application.submit", "government.application.status",
    "tax.filing.submit", "benefit.apply", "property.search", "property.viewing.book",
    "utility.service.start", "utility.meter.reading.submit", "insurance.quote.request",
    "insurance.claim.submit", "finance.account.balance.get"
  ],
  digital: [
    "content.search", "content.license.request", "media.stream.authorize",
    "digital.resource.provision", "device.register", "device.status.get", "device.command.send",
    "telemetry.publish", "sensor.reading.get", "automation.rule.trigger"
  ]
};

const standards = {
  identity: ["https://schema.org/Organization", "https://www.w3.org/TR/vc-data-model-2.0/"],
  catalog: ["https://schema.org/Product", "https://docs.oasis-open.org/ubl/UBL-2.4.html"],
  services: ["https://schema.org/Service"],
  scheduling: ["https://www.rfc-editor.org/rfc/rfc5545", "https://schema.org/ReserveAction"],
  pricing: ["https://schema.org/Offer", "https://docs.oasis-open.org/ubl/UBL-2.4.html"],
  procurement: ["https://docs.oasis-open.org/ubl/UBL-2.4.html", "https://unece.org/trade/documents/2019/08/brs-buy-ship-pay-reference-data-model-bsp-rdm"],
  orders: ["https://docs.oasis-open.org/ubl/UBL-2.4.html"],
  booking: ["https://schema.org/Reservation", "https://www.iata.org/en/programs/airline-distribution/retailing/ndc/"],
  operations: ["https://ref.gs1.org/standards/epcis/2.0.1/"],
  logistics: ["https://ref.gs1.org/standards/epcis/2.0.1/", "https://docs.oasis-open.org/ubl/UBL-2.4.html"],
  finance: ["https://www.iso20022.org/", "https://docs.oasis-open.org/ubl/UBL-2.4.html"],
  support: ["https://schema.org/ReturnAction"],
  subscriptions: ["https://schema.org/JoinAction"],
  communications: ["https://www.w3.org/TR/activitystreams-vocabulary/"],
  data: ["https://www.w3.org/TR/vc-data-model-2.0/"],
  trust: ["https://www.w3.org/TR/vc-data-model-2.0/"],
  workforce: ["https://schema.org/JobPosting"],
  social: ["https://hl7.org/fhir/"],
  publicServices: ["https://schema.org/GovernmentService"],
  digital: ["https://www.w3.org/TR/wot-thing-description11/"]
};

const actionWords = new Set([
  "get", "list", "search", "publish", "request", "accept", "end", "verify", "subscribe",
  "compare", "start", "check", "hold", "release", "create", "reschedule", "cancel",
  "checkin", "complete", "reject", "receive", "withdraw", "respond", "submit", "qualify",
  "change", "approve", "acknowledge", "modify", "book", "register", "issue", "reserve",
  "adjust", "assign", "track", "schedule", "confirm", "notify", "authorize", "dispute",
  "pause", "resume", "join", "leave", "update", "send", "grant", "revoke", "present",
  "apply", "propose", "terminate", "onboard", "enroll", "offboard", "status", "provision",
  "trigger"
]);

const queryActions = new Set(["get", "list", "search", "check", "track", "verify", "status", "compare"]);
const eventActions = new Set(["receive", "publish", "notify", "present", "send"]);
const terminalActions = new Set(["cancel", "reject", "withdraw", "release", "revoke", "end", "terminate", "leave", "offboard"]);
const acceptActions = new Set(["accept", "approve", "authorize", "confirm", "acknowledge", "complete", "grant"]);

const titleCase = value => value.split(".").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
const compactType = value => value.split(".").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("");

function partsFor(shortId) {
  const parts = shortId.split(".");
  const action = actionWords.has(parts.at(-1)) ? parts.pop() : "execute";
  return { action, resource: parts.join("."), resourceType: compactType(parts.join(".")) };
}

function purposeFor(id, action, resource) {
  const phrases = {
    get: "Retrieve", list: "List", search: "Search for", publish: "Publish", request: "Request",
    accept: "Accept", end: "End", verify: "Verify", subscribe: "Subscribe to", compare: "Compare",
    start: "Start", check: "Check", hold: "Place a hold on", release: "Release", create: "Create",
    reschedule: "Reschedule", cancel: "Cancel", checkin: "Check in to", complete: "Complete",
    reject: "Reject", receive: "Receive", withdraw: "Withdraw", respond: "Respond to", submit: "Submit",
    qualify: "Qualify", change: "Change", approve: "Approve", acknowledge: "Acknowledge",
    modify: "Modify", book: "Book", register: "Register", issue: "Issue", reserve: "Reserve",
    adjust: "Adjust", assign: "Assign", track: "Track", schedule: "Schedule", confirm: "Confirm",
    notify: "Notify about", authorize: "Authorize", dispute: "Dispute", pause: "Pause", resume: "Resume",
    join: "Join", leave: "Leave", update: "Update", send: "Send", grant: "Grant", revoke: "Revoke",
    present: "Present", apply: "Apply for", propose: "Propose", terminate: "Terminate", onboard: "Onboard",
    enroll: "Enroll in", offboard: "Offboard", status: "Retrieve status for", provision: "Provision",
    trigger: "Trigger"
  };
  return `${phrases[action] ?? "Execute"} ${resource.replaceAll(".", " ")} using an exact, schema-validated Comcom interaction.`;
}

function kindFor(action) {
  if (queryActions.has(action)) return "query";
  if (eventActions.has(action)) return "event";
  return "command";
}

const string = (description, extra = {}) => ({ type: "string", description, ...extra });
const object = (description, extra = {}) => ({ type: "object", description, ...extra });
const array = (description, items, extra = {}) => ({ type: "array", description, items, ...extra });

function parameterShape(id, action, resourceType) {
  const shapes = {
    "comcom.availability.check": {
      required: ["serviceId", "start", "end"],
      properties: {
        serviceId: string("Service or offering URI.", { format: "uri-reference" }),
        start: string("Inclusive search start.", { format: "date-time" }),
        end: string("Exclusive search end.", { format: "date-time" }),
        quantity: { type: "integer", minimum: 1, default: 1, description: "Capacity required." }
      }
    },
    "comcom.product.search": {
      required: ["criteria"],
      properties: {
        criteria: object("Typed product filters.", { additionalProperties: { type: ["string", "number", "integer", "boolean", "array"] } }),
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        cursor: string("Opaque continuation cursor.")
      }
    },
    "comcom.catalog.search": {
      required: ["criteria"],
      properties: {
        criteria: object("Typed catalog filters.", { additionalProperties: { type: ["string", "number", "integer", "boolean", "array"] } }),
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }
      }
    },
    "comcom.quote.request": {
      required: ["items", "currency"],
      properties: {
        items: array("Items and requested quantities.", object("Quote line.", {
          additionalProperties: false,
          required: ["itemId", "quantity"],
          properties: { itemId: string("Item URI.", { format: "uri-reference" }), quantity: { type: "number", exclusiveMinimum: 0 } }
        }), { minItems: 1 }),
        currency: string("ISO 4217 currency code.", { pattern: "^[A-Z]{3}$" })
      }
    },
    "comcom.order.create": {
      required: ["buyerId", "sellerId", "lines"],
      properties: {
        buyerId: string("Buyer URI.", { format: "uri-reference" }),
        sellerId: string("Seller URI.", { format: "uri-reference" }),
        lines: array("Order lines.", object("Order line.", {
          additionalProperties: false,
          required: ["itemId", "quantity"],
          properties: { itemId: string("Item URI.", { format: "uri-reference" }), quantity: { type: "number", exclusiveMinimum: 0 } }
        }), { minItems: 1 }),
        quoteId: string("Accepted quote URI.", { format: "uri-reference" })
      }
    },
    "comcom.appointment.create": {
      required: ["serviceId", "customerId", "start", "end"],
      properties: {
        serviceId: string("Service URI.", { format: "uri-reference" }),
        customerId: string("Customer URI.", { format: "uri-reference" }),
        start: string("Appointment start.", { format: "date-time" }),
        end: string("Appointment end.", { format: "date-time" })
      }
    },
    "comcom.booking.create": {
      required: ["offeringId", "customerId", "start", "end"],
      properties: {
        offeringId: string("Bookable offering URI.", { format: "uri-reference" }),
        customerId: string("Customer URI.", { format: "uri-reference" }),
        start: string("Booking start.", { format: "date-time" }),
        end: string("Booking end.", { format: "date-time" })
      }
    },
    "comcom.announcement.receive": {
      required: ["topic", "subject", "content"],
      properties: {
        topic: string("Receiver-declared topic identifier."),
        subject: string("Short announcement subject.", { maxLength: 200 }),
        content: string("Announcement content.", { maxLength: 10000 }),
        audience: array("Intended audience identifiers.", string("Audience identifier."), { uniqueItems: true })
      }
    },
    "comcom.offer.receive": {
      required: ["offerId", "validUntil", "details"],
      properties: {
        offerId: string("Offer URI.", { format: "uri-reference" }),
        validUntil: string("Offer expiry.", { format: "date-time" }),
        details: object("Structured offer details.", { additionalProperties: true })
      }
    }
  };
  if (shapes[id]) return shapes[id];

  if (["search", "list", "compare"].includes(action)) return {
    required: ["criteria"],
    properties: {
      criteria: object(`Typed ${resourceType} selection criteria.`, { additionalProperties: true }),
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      cursor: string("Opaque continuation cursor.")
    }
  };
  if (["get", "track", "status", "verify", "check"].includes(action)) return {
    required: ["resourceId"],
    properties: { resourceId: string(`${resourceType} URI.`, { format: "uri-reference" }), at: string("Evaluation time.", { format: "date-time" }) }
  };
  if (terminalActions.has(action)) return {
    required: ["resourceId"],
    properties: { resourceId: string(`${resourceType} URI.`, { format: "uri-reference" }), reason: string("Reason code or concise explanation.") }
  };
  if (acceptActions.has(action)) return {
    required: ["resourceId"],
    properties: { resourceId: string(`${resourceType} URI.`, { format: "uri-reference" }), decisionAt: string("Decision time.", { format: "date-time" }) }
  };
  if (["publish", "receive", "notify", "send", "present", "submit", "issue"].includes(action)) return {
    required: ["content"],
    properties: { content: object(`Structured ${resourceType} content.`, { additionalProperties: true }), effectiveAt: string("Effective time.", { format: "date-time" }) }
  };
  return {
    required: ["subject"],
    properties: {
      subject: object(`The ${resourceType} being acted on.`, {
        additionalProperties: false,
        required: ["type"],
        properties: { id: string("Existing resource URI.", { format: "uri-reference" }), type: { const: resourceType }, attributes: object("Typed domain attributes.", { additionalProperties: true }) }
      }),
      requestedAt: string("Requested effective time.", { format: "date-time" })
    }
  };
}

function inputSchema(capability) {
  const shape = parameterShape(capability.id, capability.action, capability.resourceType);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: capability.inputSchema,
    title: `${capability.title} input`,
    description: capability.purpose,
    type: "object",
    additionalProperties: false,
    required: ["capability", "parameters"],
    properties: {
      capability: { const: capability.id },
      parameters: { type: "object", additionalProperties: false, required: shape.required, properties: shape.properties }
    }
  };
}

function outputSchema(capability) {
  const base = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: capability.outputSchema,
    title: `${capability.title} output`,
    description: `Deterministic outcome for ${capability.id}.`,
    type: "object",
    additionalProperties: false
  };
  if (capability.kind === "event") return {
    ...base,
    required: ["disposition", "receivedAt"],
    properties: {
      disposition: { enum: ["accepted", "discarded", "duplicate"] },
      receivedAt: string("Receipt time.", { format: "date-time" })
    }
  };
  if (["search", "list", "compare"].includes(capability.action)) return {
    ...base,
    required: ["status", "items"],
    properties: {
      status: { const: "completed" },
      items: array("Matching typed resources.", { $ref: `${canonicalBase}/schemas/v0.1/resource.schema.json` }),
      nextCursor: string("Opaque continuation cursor.")
    }
  };
  return {
    ...base,
    required: ["status", "resource"],
    properties: {
      status: { enum: capability.kind === "query" ? ["completed", "failed"] : ["accepted", "inProgress", "completed", "rejected", "cancelled", "failed"] },
      resource: { $ref: `${canonicalBase}/schemas/v0.1/resource.schema.json` },
      nextActions: array("Capability IDs permitted next.", string("Capability ID.", { pattern: "^(comcom|[a-z0-9-]+(\\.[a-z0-9-]+)+)\\.[a-z0-9.-]+$" }), { uniqueItems: true })
    }
  };
}

function lifecycleFor(kind, action) {
  if (kind === "query") return ["requested -> completed", "requested -> failed"];
  if (kind === "event") return ["submitted -> accepted", "submitted -> discarded", "submitted -> duplicate", "submitted -> rejected"];
  if (terminalActions.has(action)) return ["active -> completed", "active -> rejected", "active -> failed"];
  if (acceptActions.has(action)) return ["proposed -> accepted", "proposed -> rejected", "proposed -> expired"];
  return ["requested -> accepted", "requested -> rejected", "accepted -> inProgress", "accepted -> completed", "inProgress -> completed", "inProgress -> failed", "accepted -> cancelled"];
}

function capabilityEntries() {
  const entries = [];
  for (const [domain, ids] of Object.entries(groups)) {
    for (const shortId of ids) {
      const id = `comcom.${shortId}`;
      const { action, resource, resourceType } = partsFor(shortId);
      const kind = kindFor(action);
      const slug = id.replaceAll(".", "-");
      entries.push({
        id,
        version: protocolVersion,
        status: "normative",
        domain,
        title: titleCase(shortId),
        purpose: purposeFor(id, action, resource),
        kind,
        action,
        resourceType,
        roles: kind === "event" ? { initiator: "publisher", responder: "inboxReceiver" } : { initiator: "requester", responder: "provider" },
        inputSchema: `${canonicalBase}/schemas/v0.1/capabilities/${slug}.input.schema.json`,
        outputSchema: `${canonicalBase}/schemas/v0.1/capabilities/${slug}.output.schema.json`,
        preconditions: kind === "query" ? ["Caller satisfies the declared access policy."] : ["Caller satisfies the declared access policy.", "Receiver validates the current resource state before applying the interaction."],
        transitions: lifecycleFor(kind, action),
        retry: kind === "query" ? "Safe to retry; caches may be used when the declared form permits it." : "Retry only with the same idempotency key and identical payload.",
        reversal: terminalActions.has(action) ? "This capability is itself terminal; a compensating capability is required for reversal." : "Use an explicitly advertised cancel, revoke, return, or compensating capability when available.",
        standards: standards[domain]
      });
    }
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

function exampleValue(schema, key = "value") {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.format === "date-time") return "2026-08-18T10:00:00Z";
  if (schema.format === "uri-reference") return `https://example.com/${key}`;
  if (schema.pattern === "^[A-Z]{3}$") return "USD";
  if (schema.type === "integer") return Math.max(schema.minimum ?? 1, 1);
  if (schema.type === "number") return 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "array") return [exampleValue(schema.items, key)];
  if (schema.type === "object") {
    const value = {};
    for (const required of schema.required ?? []) value[required] = exampleValue(schema.properties[required], required);
    return value;
  }
  return key === "type" ? "Resource" : `${key}-value`;
}

const resourceSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${canonicalBase}/schemas/v0.1/resource.schema.json`,
  title: "Comcom resource",
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "state"],
  properties: {
    id: string("Globally unique resource URI.", { format: "uri-reference" }),
    type: string("Registry or namespaced resource type."),
    state: string("Stable machine-readable state code."),
    attributes: object("Typed resource attributes.", { additionalProperties: true })
  }
};

const discoverySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${canonicalBase}/schemas/v0.1/discovery.schema.json`,
  title: "Comcom discovery document",
  type: "object",
  additionalProperties: false,
  required: ["versions", "manifest"],
  properties: {
    versions: array("Supported protocol versions.", string("Major.minor version.", { pattern: "^[0-9]+\\.[0-9]+$" }), { minItems: 1, uniqueItems: true }),
    manifest: string("Absolute capability manifest URL.", { format: "uri" })
  }
};

const entityRef = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type"],
  properties: { id: string("Entity URI.", { format: "uri-reference" }), type: { enum: ["person", "organization", "government", "nonprofit", "system", "device"] }, name: string("Human-readable name.") }
};

const envelopeSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${canonicalBase}/schemas/v0.1/envelope.schema.json`,
  title: "Comcom message envelope",
  type: "object",
  additionalProperties: false,
  required: ["protocolVersion", "id", "kind", "capability", "principal", "sender", "recipient", "issuedAt", "payload"],
  properties: {
    protocolVersion: { const: protocolVersion },
    id: string("Unique message URI.", { format: "uri-reference" }),
    kind: { enum: ["query", "command", "event", "result", "receipt"] },
    capability: {
      type: "object", additionalProperties: false, required: ["id", "version"],
      properties: { id: string("Capability ID.", { pattern: "^(comcom|[a-z0-9-]+(\\.[a-z0-9-]+)+)\\.[a-z0-9.-]+$" }), version: string("Capability version.", { pattern: "^[0-9]+\\.[0-9]+$" }) }
    },
    principal: entityRef,
    sender: entityRef,
    recipient: entityRef,
    agent: entityRef,
    authorization: string("External authorization or delegation reference.", { format: "uri-reference" }),
    issuedAt: string("Message creation time.", { format: "date-time" }),
    expiresAt: string("Time after which the message must not be acted on.", { format: "date-time" }),
    conversationId: string("Multi-step conversation URI.", { format: "uri-reference" }),
    correlationId: string("Message URI being answered.", { format: "uri-reference" }),
    idempotencyKey: string("Sender-scoped idempotency key.", { minLength: 16, maxLength: 200 }),
    resource: { type: "object", additionalProperties: false, required: ["type"], properties: { id: string("Resource URI.", { format: "uri-reference" }), type: string("Resource type.") } },
    payload: { type: "object" },
    extensions: { type: "object", propertyNames: { pattern: "^[a-z0-9-]+(\\.[a-z0-9-]+)+$" }, additionalProperties: true }
  },
  allOf: [
    { if: { properties: { kind: { enum: ["command", "event"] } }, required: ["kind"] }, then: { properties: { idempotencyKey: true }, required: ["idempotencyKey"] } },
    { if: { properties: { kind: { enum: ["result", "receipt"] } }, required: ["kind"] }, then: { properties: { correlationId: true }, required: ["correlationId"] } }
  ]
};

const manifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${canonicalBase}/schemas/v0.1/manifest.schema.json`,
  title: "Comcom capability manifest",
  type: "object",
  additionalProperties: false,
  required: ["protocolVersions", "entity", "roles", "baseUrl", "capabilities"],
  properties: {
    protocolVersions: array("Supported protocol versions.", string("Major.minor version.", { pattern: "^[0-9]+\\.[0-9]+$" }), { minItems: 1, uniqueItems: true }),
    entity: entityRef,
    roles: array("Conformance roles.", { enum: ["responder", "initiator", "inboxReceiver", "asyncResponder"] }, { minItems: 1, uniqueItems: true }),
    baseUrl: string("Default API base URL.", { format: "uri" }),
    securitySchemes: object("OpenAPI-compatible security scheme declarations.", { additionalProperties: true }),
    capabilities: array("Supported capability subset.", {
      type: "object", additionalProperties: false, required: ["id", "version", "direction", "inputSchema", "outputSchema", "forms"],
      properties: {
        id: string("Capability ID."), version: string("Capability version."), direction: { enum: ["send", "receive", "both"] },
        inputSchema: string("Input schema URL.", { format: "uri" }), outputSchema: string("Output schema URL.", { format: "uri" }),
        forms: array("Callable forms.", {
          type: "object", additionalProperties: false, required: ["href", "method", "contentType"],
          properties: {
            href: string("Endpoint URL.", { format: "uri" }), method: { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
            contentType: { const: "application/json" }, security: array("Security scheme names.", string("Scheme name."), { uniqueItems: true }),
            synchronous: { type: "boolean", default: true }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 300 }
          }
        }, { minItems: 1 })
      }
    }, { uniqueItems: true }),
    inbox: {
      type: "object", additionalProperties: false, required: ["href", "acceptedCapabilities"],
      properties: { href: string("Inbox URL.", { format: "uri" }), acceptedCapabilities: array("Accepted event capability IDs.", string("Capability ID."), { uniqueItems: true }), maxBytes: { type: "integer", minimum: 1 }, security: array("Security scheme names.", string("Scheme name."), { uniqueItems: true }) }
    },
    extensions: { type: "object", propertyNames: { pattern: "^[a-z0-9-]+(\\.[a-z0-9-]+)+$" }, additionalProperties: true }
  }
};

const registrySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${canonicalBase}/schemas/v0.1/registry.schema.json`,
  title: "Comcom capability registry",
  type: "object",
  additionalProperties: false,
  required: ["protocolVersion", "status", "capabilities"],
  properties: {
    protocolVersion: { const: protocolVersion }, status: { const: "normative" },
    capabilities: array("Normative capabilities.", {
      type: "object", additionalProperties: false,
      required: ["id", "version", "status", "domain", "title", "purpose", "kind", "action", "resourceType", "roles", "inputSchema", "outputSchema", "preconditions", "transitions", "retry", "reversal", "standards"],
      properties: {
        id: string("Capability ID."), version: { const: protocolVersion }, status: { const: "normative" }, domain: string("Domain group."),
        title: string("Human title."), purpose: string("Business purpose."), kind: { enum: ["query", "command", "event"] }, action: string("Normalized action."), resourceType: string("Normalized resource type."),
        roles: { type: "object", additionalProperties: false, required: ["initiator", "responder"], properties: { initiator: string("Initiator role."), responder: string("Responder role.") } },
        inputSchema: string("Input schema URL.", { format: "uri" }), outputSchema: string("Output schema URL.", { format: "uri" }),
        preconditions: array("Preconditions.", string("Precondition."), { minItems: 1 }), transitions: array("Allowed state transitions.", string("Transition."), { minItems: 1 }),
        retry: string("Retry rule."), reversal: string("Reversal rule."), standards: array("Informative standard mappings.", string("Standard URL.", { format: "uri" }), { minItems: 1, uniqueItems: true })
      }
    }, { minItems: 150, maxItems: 250 })
  }
};

const problemSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${canonicalBase}/schemas/v0.1/problem.schema.json`,
  title: "Comcom problem details",
  type: "object",
  additionalProperties: true,
  required: ["type", "title", "status"],
  properties: {
    type: string("Problem type URI.", { format: "uri-reference" }), title: string("Short stable summary."), status: { type: "integer", minimum: 400, maximum: 599 },
    detail: string("Occurrence-specific explanation."), instance: string("Occurrence URI.", { format: "uri-reference" }), code: string("Stable Comcom error code."), errors: array("Schema validation errors.", object("Validation error.", { additionalProperties: true }))
  }
};

const capabilities = capabilityEntries();
const registry = { protocolVersion, status: "normative", generatedAt: undefined, capabilities };
delete registry.generatedAt;
const files = new Map([
  ["schemas/v0.1/resource.schema.json", resourceSchema],
  ["schemas/v0.1/discovery.schema.json", discoverySchema],
  ["schemas/v0.1/envelope.schema.json", envelopeSchema],
  ["schemas/v0.1/manifest.schema.json", manifestSchema],
  ["schemas/v0.1/registry.schema.json", registrySchema],
  ["schemas/v0.1/problem.schema.json", problemSchema],
  ["registry/v0.1/capabilities.json", registry]
]);

const validFixtures = [];
const invalidFixtures = [];
for (const capability of capabilities) {
  const input = inputSchema(capability);
  const output = outputSchema(capability);
  const slug = capability.id.replaceAll(".", "-");
  files.set(`schemas/v0.1/capabilities/${slug}.input.schema.json`, input);
  files.set(`schemas/v0.1/capabilities/${slug}.output.schema.json`, output);
  const valid = exampleValue(input, "input");
  validFixtures.push({ capability: capability.id, schema: capability.inputSchema, instance: valid });
  const invalid = structuredClone(valid);
  delete invalid.capability;
  invalidFixtures.push({ capability: capability.id, schema: capability.inputSchema, instance: invalid, expectedError: "required" });
}
files.set("fixtures/v0.1/valid.json", validFixtures);
files.set("fixtures/v0.1/invalid.json", invalidFixtures);

const json = value => `${JSON.stringify(value, null, 2)}\n`;
let changed = false;
for (const [relative, value] of files) {
  const target = resolve(root, relative);
  const expected = json(value);
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = await readFile(target, "utf8"); } catch {}
    if (current !== expected) {
      changed = true;
      console.error(`Generated artifact is stale: ${relative}`);
    }
  } else {
    await writeFile(target, expected);
  }
}

if (changed) process.exitCode = 1;
else console.log(`${process.argv.includes("--check") ? "Verified" : "Generated"} ${files.size} frozen v0.1 prototype artifacts for ${capabilities.length} capability IDs.`);
