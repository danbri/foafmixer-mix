// Query a Shardborough store with SPARQL, holding the store open.
//
//   npm install @factoidal/core@0.5.1
//
// THE POINT OF THIS FILE
// `storeQuery` is stateless: it re-reads, re-verifies and re-decodes the
// block on every call, about 1.5 to 2 s each time. A HANDLE pays that
// once. Measured on factoidal-skosgraphs, 141 graphs, 45,806 labels:
//
//   open the handle          2,392 ms   once, at startup
//   any search after that      142-214 ms
//
// So a long-lived process (a chat bot, an MCP server) must open once and
// keep the handle. A process that spawns per question gets no benefit.
//
// WHAT A HANDLE DOES NOT DO
// `CONTAINS` still scans every row, so cost stays proportional to the
// store's size and a search matching nothing costs the same as one
// matching everything. There is no inverted index.

import { openStore, openStoreHandle } from '@factoidal/core/store'
import { loadEngine } from '@factoidal/core/engine'

const SKOS = 'PREFIX skos: <http://www.w3.org/2004/02/skos/core#>\n'
const RDFS = 'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n'

// The shape the handle is opened for. A handle over the WHOLE store is
// refused -- 119 artifacts against a cap of 64 -- so it is scoped to the
// blocks these queries need. Each predicate below is its own GROUP,
// UNIONed with the others -- UNION joins GROUPS, not patterns, and
// getting that wrong is a parse error, not a slow query (ask how we know).
//
// To query another predicate, add it here the same way: another
// `{ GRAPH ?g { ... } }` branch UNIONed in.
const SCOPE = SKOS + RDFS + 'SELECT ?c ?l WHERE { '
  + '{ GRAPH ?g { ?c skos:prefLabel ?l } } UNION '
  + '{ GRAPH ?g { ?c skos:exactMatch ?l } } UNION '
  + '{ GRAPH ?g { ?c rdfs:label ?l } } '
  + '}'

let engine = null
let handle = null
let openedPath = null

/**
 * Open the store once and keep it. Safe to call repeatedly; it opens on
 * the first call and returns the same handle afterwards.
 *
 * @param {string} storePath the collection root — the directory with CURRENT
 */
export async function open (storePath) {
  if (handle !== null && openedPath === storePath) return handle
  if (handle !== null) { handle.close(); handle = null }
  if (engine === null) engine = await loadEngine()
  const store = openStore(storePath, null)
  handle = openStoreHandle(engine, store, { sparql: SCOPE })
  openedPath = storePath
  return handle
}

/** Release the store. The process can exit without this; a long-lived
 *  server should call it when it drops a store. */
export function close () {
  if (handle !== null) { handle.close(); handle = null; openedPath = null }
}

/** Run one SPARQL query. `open` must have been called. */
export function sparql (query) {
  if (handle === null) throw new Error('call open(storePath) first')
  const answer = handle.query(query)
  return answer.result ?? answer
}

/** The same, flattened: one plain object per row, variable -> string. */
export function rows (query) {
  const result = sparql(query)
  const srj = result.srj ?? result
  return srj.results.bindings.map((b) => {
    const row = {}
    for (const name of srj.head.vars) row[name] = b[name]?.value ?? null
    return row
  })
}

/** A SPARQL string literal: escape what the grammar reserves. */
export function literal (text) {
  return '"' + String(text)
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
}

// ---------------------------------------------------------------- queries
//
// BIND A PREDICATE in every triple pattern. An unbound predicate makes
// the plan open every block in the manifest and the engine refuses it.
//
//   ✅  GRAPH ?g { ?c skos:prefLabel ?l }
//   ❌  GRAPH ?g { ?s ?p ?o }
//
// A cross-graph join needs a bound predicate on BOTH sides.

/** Concepts whose prefLabel contains `term`, with the graph each is in. */
export function labelSearch (term, limit = 8) {
  return rows(`${SKOS}
    SELECT ?g ?c ?label WHERE {
      GRAPH ?g { ?c skos:prefLabel ?label }
      FILTER(CONTAINS(LCASE(STR(?label)), LCASE(${literal(term)})))
    } ORDER BY ?g ?c LIMIT ${limit}`)
}

/** Which graphs mention `term` in a prefLabel, and how often. */
export function graphCounts (term, limit = 10) {
  return rows(`${SKOS}
    SELECT ?g (COUNT(*) AS ?n) WHERE {
      GRAPH ?g { ?c skos:prefLabel ?label }
      FILTER(CONTAINS(LCASE(STR(?label)), LCASE(${literal(term)})))
    } GROUP BY ?g ORDER BY DESC(?n) LIMIT ${limit}`)
}

/**
 * A cross-graph mapping: a concept in one graph, and the thing it
 * declares an exactMatch to, defined in another. The answer depends on
 * which graph each statement is in, so a triple store cannot express it.
 */
export function crossGraphMatches (term, limit = 8) {
  return rows(`${SKOS}${RDFS}
    SELECT ?from ?c ?label ?to ?target ?targetLabel WHERE {
      GRAPH ?from { ?c skos:prefLabel ?label ; skos:exactMatch ?target }
      GRAPH ?to   { ?target rdfs:label ?targetLabel }
      FILTER(?from != ?to)
      FILTER(CONTAINS(LCASE(STR(?label)), LCASE(${literal(term)})))
    } ORDER BY ?c LIMIT ${limit}`)
}

/** How many graphs and prefLabels the store holds. */
export function summary () {
  const [row] = rows(`${SKOS}
    SELECT (COUNT(DISTINCT ?g) AS ?graphs) (COUNT(*) AS ?labels)
    WHERE { GRAPH ?g { ?c skos:prefLabel ?label } }`)
  return row ?? { graphs: '0', labels: '0' }
}

// Smoke check:  node skos-query.mjs <store> <word>
if (import.meta.url === `file://${process.argv[1]}`) {
  const store = process.argv[2] ?? '/Users/danbri/working/factoidal-skosgraphs'
  const term = process.argv[3] ?? 'water'
  let t = Date.now()
  await open(store)
  console.log(`open ${Date.now() - t} ms (once)`)
  for (const w of [term, 'forest', 'bicycle']) {
    t = Date.now()
    const found = labelSearch(w, 3)
    console.log(`"${w}" ${Date.now() - t} ms, ${found.length} rows`)
  }
  t = Date.now()
  const mapped = crossGraphMatches('building', 3)
  console.log(`map "building" ${Date.now() - t} ms, ${mapped.length} rows`)
  console.log(mapped)
  close()
}
