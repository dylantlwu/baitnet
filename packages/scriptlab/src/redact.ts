// The PII redactor lives in @baitnet/training (so training can redact Corrections/Annotations
// without a circular dependency); Script Lab uses the very same implementation.
export { Redactor, redactPII, isRoleLabel, type PiiSecret } from "@baitnet/training";
