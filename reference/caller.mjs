import { randomUUID } from "node:crypto";
import { createProtocol, entity, message } from "./protocol.mjs";

const origin = process.env.COMCOM_ORIGIN ?? "http://localhost:8787";
const protocol = await createProtocol();
const buyer = entity("https://buyer.example", "organization", "Example Buyer");
const agent = entity("https://buyer.example/software/cli", "system", "Deterministic CLI");

const discovery = await fetch(`${origin}/.well-known/comcom`).then(response => response.json());
if (!protocol.validateDiscovery(discovery)) throw new Error(`Invalid discovery: ${JSON.stringify(protocol.validateDiscovery.errors)}`);
const manifest = await fetch(discovery.manifest).then(response => response.json());
if (!protocol.validateManifest(manifest)) throw new Error(`Invalid manifest: ${JSON.stringify(protocol.validateManifest.errors)}`);

async function invoke(capability, kind, parameters, idempotencyKey) {
  const declaration = manifest.capabilities.find(entry => entry.id === capability && entry.version === "0.1");
  if (!declaration) throw new Error(`Receiver does not advertise ${capability}.`);
  const request = message({
    id: `urn:uuid:${randomUUID()}`,
    kind,
    capability,
    principal: buyer,
    sender: buyer,
    recipient: manifest.entity,
    agent,
    idempotencyKey,
    payload: { capability, parameters }
  });
  const local = protocol.validateMessage(request);
  if (!local.valid) throw new Error(`Local message validation failed: ${JSON.stringify(local.errors)}`);
  const form = declaration.forms[0];
  const response = await fetch(form.href, { method: form.method, headers: { "content-type": form.contentType }, body: JSON.stringify(request) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
  const remote = protocol.validateMessage(result);
  if (!remote.valid) throw new Error(`Remote result validation failed: ${JSON.stringify(remote.errors)}`);
  return result;
}

const search = await invoke("comcom.product.search", "query", { criteria: { category: "furniture" }, limit: 10 });
console.log("Product search:", JSON.stringify(search.payload, null, 2));

const availability = await invoke("comcom.availability.check", "query", {
  serviceId: "https://vendor.example/services/consultation",
  start: "2026-08-19T09:00:00Z",
  end: "2026-08-19T10:00:00Z"
});
console.log("Availability:", JSON.stringify(availability.payload, null, 2));

const bookingKey = `booking-${randomUUID()}`;
const booking = await invoke("comcom.booking.create", "command", {
  offeringId: "https://vendor.example/services/consultation",
  customerId: buyer.id,
  start: "2026-08-19T09:00:00Z",
  end: "2026-08-19T10:00:00Z"
}, bookingKey);
console.log("Booking:", JSON.stringify(booking.payload, null, 2));

const announcement = await invoke("comcom.announcement.receive", "event", {
  topic: "supplier-update",
  subject: "Updated dispatch schedule",
  content: "Dispatch now occurs at 16:00 UTC."
}, `announcement-${randomUUID()}`);
console.log("Announcement receipt:", JSON.stringify(announcement.payload, null, 2));
