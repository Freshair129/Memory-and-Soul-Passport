import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipelineHandlers } from '../../apps/msp-server/src/transport/handlers/pipeline-handlers.mjs';
const scope = { portfolioId: 'p', tenantId: 't', businessId: 'b', workspaceId: '', agentId: '', visibility: 'private' };
const context = () => ({ schemaVersion: 'edge-published-corpus.v1', scope, corpusId: 'c', corpusGeneration: 1, manifestHash: 'a'.repeat(64),
  expiresAt: new Date(Date.now() + 40000).toISOString(), entries: [] });
const env = { MSP_PIPELINE_PRINCIPALS: JSON.stringify([{ credential: 'test-source-key', principalId: 'source', role: 'source', scope }]),
  MSP_PIPELINE_WORKER_URL: 'http://127.0.0.1:19417', MSP_PIPELINE_WORKER_TOKEN: 'test-worker-key' };
const args = () => ({ schemaVersion: 'genesisrag17.v1', productSchemaVersion: 'published-products.v1', scope, credential: 'test-source-key',
  operation: 'price', code: 'PM-A', quantity: 100, corpusContext: context() });
const reply = (request) => ({ schemaVersion: 'genesisrag17.v1', productSchemaVersion: 'published-products.v1', scope, operation: 'price',
  corpusId: 'c', corpusGeneration: 1, manifestHash: request.corpusContext.manifestHash, results: [],
  price: { code: 'PM-A', tiers: [], selected: null, status: 'PRICE_MISSING' }, lanes: { vectorCalls: 0, graphCalls: 0 }, priceBasis: 'PUBLISHED_CATALOG_SNAPSHOT_NOT_LIVE_QUOTE' });

test('product relay uses configured loopback, removes caller authority and journals no question/credential', async () => {
  const calls = [], journal = [];
  const request = args();
  const handlers = createPipelineHandlers({ env, journal: { append: (entry) => journal.push(entry) }, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => reply(request) };
  } });
  const result = await handlers.msp_pipeline_product_query({ ...request, actor: 'forged', relayCredential: 'forged', authenticatedPrincipal: {} });
  assert.equal(result.price.status, 'PRICE_MISSING');
  assert.equal(calls[0].url.href, 'http://127.0.0.1:19417/products/query');
  assert.equal(calls[0].options.redirect, 'error');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.credential, undefined); assert.equal(payload.actor, undefined);
  assert.deepEqual(payload.corpusContext, request.corpusContext);
  assert.doesNotMatch(JSON.stringify(journal), /PM-A|test-source-key|test-worker-key|forged/);
});

test('product relay denies cross-tenant nested context, missing credentials and invalid quantity before worker access', async () => {
  let calls = 0;
  const handlers = createPipelineHandlers({ env, fetchImpl: async () => { calls++; throw new Error('should not reach worker'); } });
  const request = args();
  for (const bad of [{ ...request, credential: 'wrong' }, { ...request, scope: { ...scope, tenantId: 'other' } },
    { ...request, corpusContext: { ...request.corpusContext, scope: { ...scope, businessId: 'other' } } },
    { ...request, quantity: 0 }, { ...request, corpusContext: { ...request.corpusContext, expiresAt: '2000-01-01' } }]) {
    await assert.rejects(handlers.msp_pipeline_product_query(bad));
  }
  assert.equal(calls, 0);
});

test('product relay rejects wrong manifest, legacy worker envelopes and out-of-manifest citations', async () => {
  const request = args();
  for (const response of [{ ...reply(request), manifestHash: 'b'.repeat(64) }, { schemaVersion: 'genesisrag17.v1', scope, results: [] },
    { ...reply(request), scope: { ...scope, tenantId: 'other' } },
    { ...reply(request), price: { code: 'different', tiers: [], selected: null, status: 'PRICE_MISSING' } }]) {
    const handlers = createPipelineHandlers({ env, fetchImpl: async () => ({ ok: true, json: async () => response }) });
    await assert.rejects(handlers.msp_pipeline_product_query(request), /invalid_response/);
  }
});
