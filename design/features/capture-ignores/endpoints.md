# Endpoints

No new or removed endpoints.

- Session events expose optional `data.capture_ignores` on
  `slipstream.session.started.v1`. Its published event schema documents the field.
- `GET /v1/sessions/{id}/interfaces` appends `ignore-rules` to
  `inventory.policy_exclusions` when the recorded start event has that policy.
  The full frozen policy stays on the event stream. No private client backchannel.
- The published interface.v2 schema includes the new exclusion enum value.

Install the compatible Swift decoder before starting new captures on this daemon.
Legacy sessions and the previous 71 contract cases retain their original responses.
