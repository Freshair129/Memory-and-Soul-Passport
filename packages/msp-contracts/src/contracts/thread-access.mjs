import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { validateThreadContract } from './thread-schema.mjs';

export function signThreadRequest(name, input, claims, key, now = Date.now()) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('MSP_THREAD_SERVICE_KEY_REQUIRED');
  const grant = { ...claims, operation: name, expiresAt: now + 60_000,
    payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
  return { ...input, access: { grant, signature: createHmac('sha256', key).update(JSON.stringify(grant)).digest('hex') } };
}

// This is the external service boundary. Domain methods remain independently
// testable; every registered API-010 tool is wrapped here before dispatch.
export function guardThreadHandler({ name, handler, db, key, clock = Date.now }) {
  return async (args = {}) => {
    const deny = () => { throw new Error('MSP_THREAD_ACCESS_DENIED'); };
    if (typeof key !== 'string' || key.length < 32) return deny();
    const { access, ...input } = args;
    const grant = access?.grant;
    if (!grant || grant.operation !== name || !Number.isFinite(grant.expiresAt) ||
        grant.expiresAt <= clock() || grant.expiresAt > clock() + 65_000) return deny();
    const actual = Buffer.from(typeof access.signature === 'string' ? access.signature : '', 'hex');
    const expected = createHmac('sha256', key).update(JSON.stringify(grant)).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return deny();
    if (grant.payloadHash !== createHash('sha256').update(JSON.stringify(input)).digest('hex')) return deny();
    if (!grant.tenantId || !grant.principalId || !grant.policyRevision) return deny();
    validateThreadContract(name, args);

    let thread;
    if (input.thread_id) thread = db.prepare('SELECT * FROM threads WHERE thread_id = ?').get(input.thread_id);
    else if (input.session_id) thread = db.prepare('SELECT t.* FROM threads t JOIN chat_sessions s ON s.thread_id=t.thread_id WHERE s.session_id=?').get(input.session_id);
    else if (input.job_id) thread = db.prepare('SELECT t.* FROM threads t JOIN session_compaction_jobs j ON j.thread_id=t.thread_id WHERE j.job_id=?').get(input.job_id);
    else if (name === 'msp_thread_delivery_record') thread = db.prepare('SELECT t.* FROM threads t JOIN thread_messages m ON m.thread_id=t.thread_id WHERE m.message_id=?').get(input.inbound_message_id);
    if (name === 'msp_thread_resolve') {
      if (input.tenant_id !== grant.tenantId || (input.business_id ?? null) !== (grant.businessId ?? null) ||
          input.channel_account_id !== grant.channelAccountId || input.external_room_ref !== grant.externalRoomRef) return deny();
    } else if (thread) {
      if (thread.status !== 'ACTIVE' || thread.tenant_id !== grant.tenantId ||
          thread.business_id !== (grant.businessId ?? null) || thread.channel_account_id !== grant.channelAccountId ||
          thread.external_room_ref !== grant.externalRoomRef) return deny();
    } else if (!['msp_session_sweep', 'msp_thread_delivery_record'].includes(name)) return deny();

    if (name === 'msp_thread_context') {
      if (!grant.readPrivate || thread.audience_kind !== 'DIRECT' || grant.audienceKind !== 'DIRECT') return deny();
      const member = db.prepare("SELECT * FROM thread_participants WHERE thread_id=? AND speaker_id=? AND left_at IS NULL").get(thread.thread_id, grant.principalId);
      if (!member || member.identity_assurance !== 'VERIFIED') return deny();
      input.requester_person_id = grant.principalId;
    }
    if (name === 'msp_thread_message_append' && input.speaker_kind === 'HUMAN' && input.speaker_id !== grant.principalId) return deny();
    if (name === 'msp_thread_memory_record' && (!grant.writePrivate || thread.audience_kind !== 'DIRECT' || grant.audienceKind !== 'DIRECT' || input.asserted_by_speaker_id !== grant.principalId)) return deny();
    if (name === 'msp_thread_injection_record' && (!grant.readPrivate || thread.audience_kind !== 'DIRECT' || grant.audienceKind !== 'DIRECT')) return deny();
    if (name === 'msp_thread_memory_record' && input.verification_state === 'CONFIRMED' && grant.confirmMemory !== true) return deny();
    if (name.startsWith('msp_session_') && !grant.operator) return deny();
    if (name === 'msp_thread_delivery_record' && !grant.deliveryWriter) return deny();
    if (name === 'msp_thread_delivery_record') {
      if (!grant.channelAccountId || !grant.externalRoomRef) return deny();
      input.delivery_scope = { tenantId: grant.tenantId, businessId: grant.businessId ?? null,
        channelAccountId: grant.channelAccountId, externalRoomRef: grant.externalRoomRef };
    }
    if (name === 'msp_session_compaction_commit') {
      if (!input.lease_token || !input.source_digest) return deny();
      for (const value of Object.values(input.summary ?? {})) {
        if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object')) return deny();
      }
    }
    // Sweep must never turn a tenant-bound operator into an all-tenant worker.
    if (name === 'msp_session_sweep') {
      input.tenant_id = grant.tenantId;
      input.business_id = grant.businessId ?? null;
      input.channel_account_id = grant.channelAccountId;
      input.external_room_ref = grant.externalRoomRef;
      if (!input.channel_account_id || !input.external_room_ref) return deny();
    }
    const result = await handler(input);
    validateThreadContract(name, result, 'output');
    return result;
  };
}
