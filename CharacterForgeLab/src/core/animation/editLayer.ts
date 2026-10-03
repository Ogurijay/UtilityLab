import * as THREE from 'three'

function parseTrack(trackName: string): { bone: string; property: string } | null {
  const parsed = THREE.PropertyBinding.parseTrackName(trackName)
  if (!parsed.nodeName || !parsed.propertyName) return null
  return {
    bone: parsed.nodeName.toLowerCase().replace(/[^a-z0-9]/g, ''),
    property: parsed.propertyName,
  }
}

function trackKey(track: THREE.KeyframeTrack): string {
  const target = parseTrack(track.name)
  return target ? `${target.bone}.${target.property}` : track.name
}

function withKeyframe(
  source: THREE.KeyframeTrack | null,
  bone: THREE.Bone,
  property: 'quaternion' | 'position',
  time: number,
  value: readonly number[],
): THREE.KeyframeTrack {
  const size = property === 'quaternion' ? 4 : 3
  const times = source ? Array.from(source.times) : []
  const values = source ? Array.from(source.values) : []
  const existing = times.findIndex((item) => Math.abs(item - time) < 0.0001)
  if (existing >= 0) {
    times[existing] = time
    values.splice(existing * size, size, ...value)
  } else {
    const later = times.findIndex((item) => item > time)
    const insertAt = later < 0 ? times.length : later
    times.splice(insertAt, 0, time)
    values.splice(insertAt * size, 0, ...value)
  }
  const name = source?.name || `${bone.name}.${property}`
  return property === 'quaternion'
    ? new THREE.QuaternionKeyframeTrack(name, times, values)
    : new THREE.VectorKeyframeTrack(name, times, values)
}

/**
 * 非破坏动画编辑层：源动画保持不变，单骨骼关键帧以覆盖轨道保存。
 * 导出或播放时再组合为派生 AnimationClip（动画片段）。
 */
export class AnimationEditLayer {
  readonly sourceClip: THREE.AnimationClip
  readonly displayName: string
  private readonly overrides = new Map<string, THREE.KeyframeTrack>()

  constructor(sourceClip: THREE.AnimationClip, displayName = sourceClip.name) {
    this.sourceClip = sourceClip.clone()
    this.displayName = displayName
  }

  setBoneTransform(
    bone: THREE.Bone,
    property: 'quaternion' | 'position',
    time: number,
    value: readonly number[],
  ): THREE.AnimationClip {
    const key = `${bone.name.toLowerCase().replace(/[^a-z0-9]/g, '')}.${property}`
    const source = this.overrides.get(key)
      || this.sourceClip.tracks.find((track) => trackKey(track) === key)
      || null
    this.overrides.set(key, withKeyframe(source, bone, property, time, value))
    return this.compose()
  }

  compose(): THREE.AnimationClip {
    const tracks = this.sourceClip.tracks
      .filter((track) => !this.overrides.has(trackKey(track)))
      .map((track) => track.clone())
    tracks.push(...[...this.overrides.values()].map((track) => track.clone()))
    const name = this.displayName.endsWith('（已编辑）')
      ? this.displayName
      : `${this.displayName}（已编辑）`
    const clip = new THREE.AnimationClip(name, this.sourceClip.duration, tracks)
    clip.resetDuration()
    return clip
  }

  get trackCount(): number {
    return this.overrides.size
  }
}
