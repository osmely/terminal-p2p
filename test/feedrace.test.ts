import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FeedRace, RACE_WAIT_MS, type FeedEvent } from '../worker/livebook.ts'

const ev = (uuid: string, event = 'p2p.created', at = '2026-11-25T20:00:00Z') => ({ event, data: { uuid, updated_at: at } }) as unknown as FeedEvent

test('carrera de avisos: quién llega primero (webhook o stream), por cuánto, y los que solo llegan por uno', () => {
	const r = new FeedRace()
	const T = 1_000_000
	// El stream gana por 5 y por 15 ms; el webhook por 30
	r.add(ev('a'), 'stream', T)
	r.add(ev('a'), 'hook', T + 5)
	r.add(ev('b'), 'stream', T)
	r.add(ev('b'), 'hook', T + 15)
	r.add(ev('c'), 'hook', T)
	r.add(ev('c'), 'stream', T + 30)
	// El mismo camino dos veces no cuenta como carrera
	r.add(ev('d'), 'stream', T)
	r.add(ev('d'), 'stream', T + 1)
	// Mismo uuid pero otro evento: otra carrera
	r.add(ev('a', 'p2p.applied'), 'hook', T)
	let s = r.stats(T + 100)
	assert.deepEqual([s.stream, s.hook, s.onlyStream, s.onlyHook], [2, 1, 0, 0])
	assert.deepEqual(s.streamLead, { p50: 15, p90: 15 })
	assert.deepEqual(s.hookLead, { p50: 30, p90: 30 })
	// Pasado el tiempo de espera, los que llegaron por un solo camino
	s = r.stats(T + RACE_WAIT_MS + 1)
	assert.deepEqual([s.onlyStream, s.onlyHook], [1, 1])
})
