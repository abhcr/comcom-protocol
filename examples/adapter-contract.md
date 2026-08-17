# AI and UI adapter boundary

Comcom does not define an AI endpoint. An adapter consumes the same manifest and schemas as conventional code.

For the request “Book a consultation tomorrow from 9 to 10,” an edge adapter performs this local work:

1. Discover the provider's manifest.
2. Select the exact advertised `comcom.booking.create` capability.
3. Resolve “tomorrow” to an explicit timestamp in the user's timezone.
4. Collect the required `offeringId` and `customerId` if missing.
5. Show the exact provider, time, price, and policies.
6. Obtain any required confirmation.
7. Produce the same schema-valid message a conventional form or application would produce.

The adapter's prompt, confidence, model, transcript, and reasoning are not sent. The structured result is authoritative; the adapter may explain it but cannot change it.
