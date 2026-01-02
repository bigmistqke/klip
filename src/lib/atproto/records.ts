import type { Agent } from '@atproto/api'
import type { Project, StemRef } from '../project/types'

export interface RecordRef {
  uri: string
  cid: string
}

export interface ProjectListItem {
  uri: string
  cid: string
  rkey: string
  title: string
  createdAt: string
  trackCount: number
}

// Parse AT URI into components: at://did/collection/rkey
function parseAtUri(uri: string): { repo: string; collection: string; rkey: string } {
  const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/)
  if (!match) throw new Error(`Invalid AT URI: ${uri}`)
  return { repo: match[1], collection: match[2], rkey: match[3] }
}

export interface ProjectRecord {
  uri: string
  cid: string
  value: {
    schemaVersion?: number
    title: string
    canvas: { width: number; height: number }
    groups: Array<{
      type: string
      id: string
      columns?: number
      rows?: number
      members: Array<{ id: string }>
    }>
    tracks: Array<{
      id: string
      clips: Array<{
        id: string
        stem?: { uri: string; cid: string }
        offset: number
        duration: number
      }>
      audioPipeline?: Array<{
        type: string
        value: { value: number }
      }>
    }>
    createdAt: string
  }
}

export async function getProject(agent: Agent, uri: string): Promise<ProjectRecord> {
  const { repo, collection, rkey } = parseAtUri(uri)
  const response = await agent.com.atproto.repo.getRecord({
    repo,
    collection,
    rkey,
  })
  return {
    uri: response.data.uri,
    cid: response.data.cid ?? '',
    value: response.data.value as ProjectRecord['value'],
  }
}

// Resolve a handle to a DID
async function resolveHandle(agent: Agent, handle: string): Promise<string> {
  const response = await agent.resolveHandle({ handle })
  return response.data.did
}

// Get project by handle (optional) and rkey
// If no handle provided, uses the agent's own DID
export async function getProjectByRkey(
  agent: Agent,
  rkey: string,
  handle?: string
): Promise<ProjectRecord> {
  let did: string
  if (handle) {
    did = await resolveHandle(agent, handle)
  } else {
    did = agent.assertDid
  }

  const uri = `at://${did}/app.klip.project/${rkey}`
  return getProject(agent, uri)
}

interface StemRecord {
  blob: {
    $type: 'blob'
    ref: { $link: string }
    mimeType: string
    size: number
  }
  mimeType: string
  duration: number
}

export async function getStemBlob(agent: Agent, stemUri: string): Promise<Blob> {
  // First fetch the stem record to get the blob ref
  const { repo, collection, rkey } = parseAtUri(stemUri)
  const stemResponse = await agent.com.atproto.repo.getRecord({
    repo,
    collection,
    rkey,
  })

  const stemValue = stemResponse.data.value as StemRecord
  // blob.ref is a CID object, need to convert to string
  const blobRef = stemValue.blob?.ref as unknown as { toString(): string }
  const blobCid = blobRef?.toString()

  console.log('Fetching blob:', { did: repo, cid: blobCid })

  // Fetch the actual blob
  const blobResponse = await agent.com.atproto.sync.getBlob({
    did: repo,
    cid: blobCid,
  })

  return new Blob([blobResponse.data as BlobPart], { type: stemValue.mimeType })
}

export async function listProjects(agent: Agent): Promise<ProjectListItem[]> {
  const response = await agent.com.atproto.repo.listRecords({
    repo: agent.assertDid,
    collection: 'app.klip.project',
    limit: 50,
  })

  return response.data.records.map((record) => {
    const value = record.value as {
      title?: string
      createdAt?: string
      tracks?: unknown[]
    }
    const { rkey } = parseAtUri(record.uri)
    return {
      uri: record.uri,
      cid: record.cid,
      rkey,
      title: value.title ?? 'Untitled',
      createdAt: value.createdAt ?? '',
      trackCount: value.tracks?.length ?? 0,
    }
  })
}

export async function uploadBlob(
  agent: Agent,
  blob: Blob
) {
  const response = await agent.uploadBlob(blob, {
    encoding: blob.type,
  })
  return response.data.blob
}

export async function createStemRecord(
  agent: Agent,
  blob: Blob,
  duration: number
): Promise<RecordRef> {
  const uploadedBlob = await uploadBlob(agent, blob)

  const record = {
    $type: 'app.klip.stem',
    schemaVersion: 1,
    blob: uploadedBlob,
    type: 'video',
    mimeType: blob.type,
    duration: Math.round(duration),
    video: {
      hasAudio: true,
    },
    createdAt: new Date().toISOString(),
  }

  const response = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: 'app.klip.stem',
    record,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
  }
}

export async function publishProject(
  agent: Agent,
  project: Project,
  clipBlobs: Map<string, { blob: Blob; duration: number }>
): Promise<RecordRef> {
  // Upload stems for clips that have local blobs
  const stemRefs = new Map<string, StemRef>()

  for (const [clipId, { blob, duration }] of clipBlobs) {
    const stemRecord = await createStemRecord(agent, blob, duration)
    stemRefs.set(clipId, {
      uri: stemRecord.uri,
      cid: stemRecord.cid,
    })
  }

  // Build tracks - stem is now on each clip
  const tracks = project.tracks
    .filter((track) => track.clips.some((clip) => stemRefs.has(clip.id)))
    .map((track) => ({
      id: track.id,
      clips: track.clips
        .filter((clip) => stemRefs.has(clip.id))
        .map((clip) => ({
          id: clip.id,
          stem: stemRefs.get(clip.id),
          offset: clip.offset,
          duration: clip.duration,
        })),
      audioPipeline: track.audioPipeline,
    }))

  // Build project record
  const record = {
    $type: 'app.klip.project',
    schemaVersion: 1,
    title: project.title,
    canvas: {
      width: project.canvas.width,
      height: project.canvas.height,
    },
    groups: project.groups.map((group) => ({
      type: group.type,
      id: group.id,
      columns: group.columns,
      rows: group.rows,
      members: group.members.map((m) => ({ id: m.id })),
    })),
    tracks,
    createdAt: project.createdAt,
  }

  console.log('Creating project record:', JSON.stringify(record, null, 2))

  // Note: Local validation with @atproto/lexicon doesn't support union types
  // The PDS will validate the record server-side

  const response = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: 'app.klip.project',
    record,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
  }
}
