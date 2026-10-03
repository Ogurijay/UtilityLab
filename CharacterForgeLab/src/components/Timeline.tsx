import { useCallback, useRef } from 'react'
import { useEditor } from '../store/editor'
import {
  applyTrimAsNewClip, seek, setLoop, setSpeed, setTrim, stopPlayback, togglePlay,
} from '../app/controller'
import { Icon } from './Icons'

const FPS = 30
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

export function Timeline() {
  const pb = useEditor((s) => s.playback)
  const clips = useEditor((s) => s.clips)
  const trackRef = useRef<HTMLDivElement>(null)

  const clip = clips.find((c) => c.id === pb.clipId)
  const dur = Math.max(pb.duration, 0.0001)
  const effOut = pb.trimOut > 0 ? pb.trimOut : dur
  const trimmed = pb.trimIn > 0.001 || (pb.trimOut > 0 && pb.trimOut < dur - 0.001)

  const timeAt = useCallback(
    (clientX: number) => {
      const el = trackRef.current
      if (!el) return 0
      const r = el.getBoundingClientRect()
      const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
      return pct * dur
    },
    [dur],
  )

  const onScrub = (e: React.PointerEvent) => {
    if (!clip) return
    e.currentTarget.setPointerCapture(e.pointerId)
    seek(timeAt(e.clientX))
    const move = (ev: PointerEvent) => seek(timeAt(ev.clientX))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const dragTrim = (side: 'in' | 'out') => (e: React.PointerEvent) => {
    if (!clip) return
    e.stopPropagation()
    const move = (ev: PointerEvent) => {
      const t = timeAt(ev.clientX)
      const cur = useEditor.getState().playback
      const curOut = cur.trimOut > 0 ? cur.trimOut : dur
      if (side === 'in') {
        setTrim(Math.min(Math.max(t, 0), curOut - 0.1), cur.trimOut)
      } else {
        const newOut = Math.max(t, cur.trimIn + 0.1)
        setTrim(cur.trimIn, newOut >= dur - 0.001 ? 0 : newOut)
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const pct = (t: number) => `${(Math.min(t, dur) / dur) * 100}%`
  const seconds = Math.max(1, Math.ceil(dur))
  const ticks = Array.from({ length: seconds + 1 }, (_, i) => i).filter((i) => i <= dur + 0.001)

  return (
    <footer className="timeline">
      <div className="tl-transport">
        <button className="icon-btn solid" title="跳到开头" disabled={!clip} onClick={() => seek(pb.trimIn)}>
          <Icon name="skipBack" size={13} />
        </button>
        <button
          className="icon-btn solid"
          title="播放 / 暂停（空格）"
          disabled={!clip && clips.length === 0}
          onClick={togglePlay}
        >
          <Icon name={pb.playing ? 'pause' : 'play'} size={13} />
        </button>
        <button className="icon-btn solid" title="停止并回到默认姿势" disabled={!clip} onClick={stopPlayback}>
          <Icon name="stop" size={12} />
        </button>
        <button
          className={`icon-btn solid ${pb.loop ? 'active' : ''}`}
          title="循环播放"
          disabled={!clip}
          onClick={() => setLoop(!pb.loop)}
        >
          <Icon name="loop" size={13} />
        </button>
        <select value={pb.speed} disabled={!clip} title="播放速度" onChange={(e) => setSpeed(parseFloat(e.target.value))}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>{s}×</option>
          ))}
        </select>

        <span className="clipname">{clip ? clip.name : '未选择动画'}</span>
        <span className="frames">
          {clip
            ? `${pb.time.toFixed(2)}s / ${dur.toFixed(2)}s · 第 ${Math.round(pb.time * FPS)} / ${Math.round(dur * FPS)} 帧`
            : '在「动画」页或资源库选一条动画'}
        </span>
        <span className="spacer" />
        {trimmed && (
          <>
            <span className="frames">裁剪 {Math.round(pb.trimIn * FPS)} → {Math.round(effOut * FPS)} 帧</span>
            <button className="btn small" onClick={applyTrimAsNewClip}>
              <Icon name="scissors" size={13} />
              存为新片段
            </button>
            <button className="btn ghost small" onClick={() => setTrim(0, 0)}>清除</button>
          </>
        )}
      </div>

      <div className="tl-track-wrap">
        <div className="tl-ruler">
          {clip &&
            ticks.map((i) => (
              <span key={i} className="tick" style={{ left: pct(i) }}>{i}s</span>
            ))}
        </div>
        <div ref={trackRef} className={`tl-track ${clip ? '' : 'disabled'}`} onPointerDown={onScrub}>
          {clip && (
            <>
              <div className="tl-progress" style={{ width: pct(pb.time) }} />
              <div className="tl-trim-shade" style={{ left: 0, width: pct(pb.trimIn) }} />
              <div className="tl-trim-shade" style={{ left: pct(effOut), right: 0 }} />
              <div className="tl-playhead" style={{ left: pct(pb.time) }} />
              <div
                className="tl-trim-handle"
                title="拖动设置起始帧"
                style={{ left: `calc(${pct(pb.trimIn)} - 5px)` }}
                onPointerDown={dragTrim('in')}
              />
              <div
                className="tl-trim-handle"
                title="拖动设置结束帧"
                style={{ left: `calc(${pct(effOut)} - 5px)` }}
                onPointerDown={dragTrim('out')}
              />
            </>
          )}
        </div>
      </div>
    </footer>
  )
}
