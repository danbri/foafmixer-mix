// Query a Shardborough store with SPARQL, from any Node script.
//
//   npm install @factoidal/core
//
// The engine reads CURRENT, picks the artifacts the query needs from the
// manifest, and verifies each against its committed SHA-256 before it
// answers. Nothing here parses RDF or chooses a block.
//
// It spawns the `factoidal` command because @factoidal/core 0.4.0 exports
// `store-host` (file I/O) but not the store query driver. When 0.5.0 adds
// that export, `sparql()` below is the only function that changes.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const CLI = require
  .resolve('@factoidal/core/package.json')
  .replace(/package\.json$/, 'bin/factoidal.mjs')

// Each query costs real, sustained CPU (tens of seconds, independent of
// result count -- an @factoidal/core 0.4.0 engine characteristic). Killing
// the caller does NOT kill an in-flight spawned child on its own -- Unix
// doesn't propagate a kill to children, so it's orphaned and keeps burning
// CPU. Track every child here so a caller can clean up on exit.
const activeChildren = new Set()

/** Kill every query subprocess still running. Call from a shutdown handler. */
export function killActiveQueries () {
  for (const child of activeChildren) child.kill('SIGTERM')
}

/**
 * Run one SPARQL query against a store.
 *
 * @param {string} store  the collection root — the directory holding CURRENT
 * @param {string} query  SPARQL text
 * @returns {Promise<object>} SPARQL 1.1 Query Results JSON
 */
export function sparql (store, query) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [CLI, 'query', store, '--query', query, '--format', 'json', '--quiet'],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    activeChildren.add(child)
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => {
      activeChildren.delete(child)
      if (code !== 0) return reject(new Error(err.trim() || `exit ${code}`))
      try { resolve(JSON.parse(out)) } catch (e) { reject(e) }
    })
  })
}

/** The same, flattened to plain objects: one per row, variable → string. */
export async function rows (store, query) {
  const srj = await sparql(store, query)
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

// ------------------------------------------------------------------------
// TWO CAPS THAT DECIDE HOW YOU WRITE QUERIES
//
// The store query operation refuses a plan above 64 artifacts, 8,388,608
// bytes, or 100,000 rows. It says which cap and by how much.
//
// In practice that means: BIND A PREDICATE in every triple pattern. An
// unbound predicate makes the plan open every block in the manifest.
//
//   ✅  GRAPH ?g { ?c skos:prefLabel ?label }      one block
//   ❌  GRAPH ?g { ?s ?p ?o }                       every block, refused
//
// A cross-graph join needs a bound predicate on BOTH sides.
// https://github.com/danbri/factoidal/issues/648
// ------------------------------------------------------------------------

const SKOS = 'PREFIX skos: <http://www.w3.org/2004/02/skos/core#>\n'
const RDFS = 'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n'

/** Concepts whose prefLabel contains `term`, with the graph each is in. */
export function labelSearch (store, term, limit = 8) {
  return rows(store, `${SKOS}
    SELECT ?g ?c ?label WHERE {
      GRAPH ?g { ?c skos:prefLabel ?label }
      FILTER(CONTAINS(LCASE(STR(?label)), LCASE(${literal(term)})))
    } ORDER BY ?g ?c LIMIT ${limit}`)
}

/** Which graphs mention `term` in a prefLabel, and how often. */
export function graphCounts (store, term, limit = 10) {
  return rows(store, `${SKOS}
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
export function crossGraphMatches (store, term, limit = 8) {
  return rows(store, `${SKOS}${RDFS}
    SELECT ?from ?c ?label ?to ?target ?targetLabel WHERE {
      GRAPH ?from { ?c skos:prefLabel ?label ; skos:exactMatch ?target }
      GRAPH ?to   { ?target rdfs:label ?targetLabel }
      FILTER(?from != ?to)
      FILTER(CONTAINS(LCASE(STR(?label)), LCASE(${literal(term)})))
    } ORDER BY ?c LIMIT ${limit}`)
}

/** How many graphs and prefLabels the store holds. */
export async function summary (store) {
  const [row] = await rows(store, `${SKOS}
    SELECT (COUNT(DISTINCT ?g) AS ?graphs) (COUNT(*) AS ?labels)
    WHERE { GRAPH ?g { ?c skos:prefLabel ?label } }`)
  return row ?? { graphs: '0', labels: '0' }
}

// Run directly for a smoke check:  node skos-query.mjs <store> <word>
if (import.meta.url === `file://${process.argv[1]}`) {
  const store = process.argv[2] ?? '/Users/danbri/working/factoidal-skosgraphs'
  const term = process.argv[3] ?? 'water'
  console.log(await summary(store))
  for (const r of await labelSearch(store, term, 5)) {
    console.log(`${r.g.split('/').pop()}  "${r.label}"  ${r.c}`)
  }
}
