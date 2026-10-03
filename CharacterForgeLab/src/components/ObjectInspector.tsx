import { useEditor } from '../store/editor'
import type { MaterialTextureSlot, SculptBrush } from '../types'
import {
  clearMaterialTexture, groundCharacter, resetTransform, setCharacterTransform,
  setCutPlanePreset, setCutPlaneVisible, setMaterialProp, setMaterialTexture,
  setObjectNodeTransform, setSculptSettings, setUniformScale, setWireframe,
  splitSelectedObject, splitSelectedObjectByPlane,
} from '../app/controller'
import { Section, SliderRow, Vec3Row } from './common'
import { Icon } from './Icons'

const BRUSHES: { id: SculptBrush; label: string; detail: string }[] = [
  { id: 'grab', label: '抓取', detail: '直接拖动局部顶点' },
  { id: 'inflate', label: '鼓起', detail: '沿各顶点法线推拉' },
  { id: 'smooth', label: '平滑', detail: '减弱局部凹凸' },
  { id: 'flatten', label: '压平', detail: '向笔刷切平面靠拢' },
  { id: 'extend', label: '延长', detail: '沿命中方向整体拉伸' },
]

const TEXTURE_SLOTS: { id: MaterialTextureSlot; label: string }[] = [
  { id: 'map', label: '颜色' },
  { id: 'normalMap', label: '法线' },
  { id: 'roughnessMap', label: '粗糙度' },
  { id: 'metalnessMap', label: '金属度' },
]

export function ObjectInspector() {
  const selection = useEditor((s) => s.selection)
  const selectedIds = useEditor((s) => s.objectSelectedIds)
  const objectTool = useEditor((s) => s.objectTool)
  const rootTransform = useEditor((s) => s.transform)
  const nodeTransform = useEditor((s) => s.objectTransform)
  const nodes = useEditor((s) => s.objectNodes)
  const materials = useEditor((s) => s.materials)
  const wireframe = useEditor((s) => s.wireframe)
  const uniformScale = useEditor((s) => s.uniformScale)
  const brush = useEditor((s) => s.sculptBrush)
  const radius = useEditor((s) => s.sculptRadius)
  const strength = useEditor((s) => s.sculptStrength)
  const cutPlaneOn = useEditor((s) => s.cutPlaneOn)

  const selectedId = selection?.kind === 'object' && selection.id
    ? selection.id
    : selectedIds[0]
  const selectedNode = nodes.find((node) => node.id === selectedId)
  const editingRoot = !selectedNode
  const transform = selectedNode ? nodeTransform : rootTransform

  const changeTransform = (patch: Parameters<typeof setCharacterTransform>[0]) => {
    if (selectedNode) setObjectNodeTransform(selectedNode.id, patch)
    else setCharacterTransform(patch)
  }

  const modeLabel = objectTool === 'sculpt'
    ? '雕刻工具'
    : objectTool === 'split'
      ? '拆分工具'
      : selectedNode
        ? '组件属性'
        : '物体属性'

  return (
    <aside className="insp object-inspector">
      <div className="object-inspector-head">
        <div className="object-kicker">{modeLabel}</div>
        <strong>{selectedNode?.name ?? '物体整体'}</strong>
        <span>
          {objectTool === 'sculpt'
            ? '在视口网格表面按住左键拖动；一次拖动是一条可撤销记录。'
            : objectTool === 'split'
              ? '原组件会被真正替换为多个新组件，不会额外复制一整份模型。'
              : selectedNode
                ? '只调整当前网格，不影响同一物体内的其他组件。'
                : '调整整个物体，所有内部组件会一起移动。'}
        </span>
      </div>

      <div className="insp-body">
        {objectTool === 'select' && (
          <Section
            title={selectedNode ? '组件变换' : '整体变换'}
            right={(
              <button
                className={`btn small transform-lock ${uniformScale ? 'active' : ''}`}
                title={uniformScale ? '已锁定长宽高比例' : '长宽高可以独立缩放'}
                onClick={() => setUniformScale(!uniformScale)}
              >
                <Icon name={uniformScale ? 'lock' : 'unlock'} size={12} />
                {uniformScale ? '等比' : '自由'}
              </button>
            )}
          >
            <Vec3Row
              label="位置 m"
              x={transform.px} y={transform.py} z={transform.pz}
              step={0.01} digits={3}
              sliderMin={-5} sliderMax={5}
              onChange={(axis, value) => changeTransform({
                [axis === 'x' ? 'px' : axis === 'y' ? 'py' : 'pz']: value,
              })}
            />
            <Vec3Row
              label="旋转 °"
              x={transform.rx} y={transform.ry} z={transform.rz}
              step={0.5} digits={1}
              min={-360} max={360}
              sliderMin={-180} sliderMax={180}
              onChange={(axis, value) => changeTransform({
                [axis === 'x' ? 'rx' : axis === 'y' ? 'ry' : 'rz']: value,
              })}
            />
            <Vec3Row
              label="缩放"
              x={transform.sx} y={transform.sy} z={transform.sz}
              step={0.01} digits={3}
              min={0.01}
              sliderMin={0.01} sliderMax={5}
              onChange={(axis, value) => changeTransform({
                [axis === 'x' ? 'sx' : axis === 'y' ? 'sy' : 'sz']: value,
              })}
            />
            <div className="row wrap">
              {editingRoot && (
                <button className="btn small" onClick={() => groundCharacter()}>
                  <Icon name="ground" size={13} />
                  落地
                </button>
              )}
              <button
                className="btn small"
                onClick={() => {
                  if (selectedNode) {
                    setObjectNodeTransform(selectedNode.id, {
                      px: 0, py: 0, pz: 0,
                      rx: 0, ry: 0, rz: 0,
                      sx: 1, sy: 1, sz: 1,
                    })
                  } else {
                    resetTransform()
                  }
                }}
              >
                重置变换
              </button>
            </div>
            <div className="hint">
              每个轴都可拖动滑条、左右拖拽标签或直接输入数值；W / E / R 可切换视口操纵器。
            </div>
          </Section>
        )}

        {objectTool === 'sculpt' && (
          <Section title="基础雕刻笔刷">
            {!selectedNode ? (
              <div className="hint">请先从左侧或视口选择一个静态网格。</div>
            ) : !selectedNode.sculptable ? (
              <div className="hint warn-text">蒙皮网格不能直接雕刻，避免破坏骨骼权重；请使用静态网格副本。</div>
            ) : (
              <div className="object-mesh-summary">
                <b>{selectedNode.name}</b>
                <span>{selectedNode.vertices.toLocaleString()} 个顶点</span>
              </div>
            )}
            <div className="sculpt-brush-grid">
              {BRUSHES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={brush === item.id ? 'active' : ''}
                  title={item.detail}
                  onClick={() => setSculptSettings({ brush: item.id })}
                >
                  <b>{item.label}</b>
                  <span>{item.detail}</span>
                </button>
              ))}
            </div>
            <SliderRow
              label="笔刷半径"
              value={radius}
              min={0.01}
              max={2}
              step={0.01}
              onChange={(value) => setSculptSettings({ radius: value })}
            />
            <SliderRow
              label="笔刷强度"
              value={strength}
              min={0.01}
              max={1}
              step={0.01}
              onChange={(value) => setSculptSettings({ strength: value })}
            />
            <div className="hint">
              这是可靠的顶点雕刻，不包含 Blender 的动态拓扑。网格顶点越密，局部形变越细；顶点很少时适合做整体拉伸。
            </div>
          </Section>
        )}

        {objectTool === 'split' && (
          <>
            <Section
              title="切面拆分"
              right={(
                <label className="row object-wireframe">
                  <input
                    type="checkbox"
                    checked={cutPlaneOn}
                    onChange={(event) => setCutPlaneVisible(event.target.checked)}
                  />
                  切割平面
                </label>
              )}
            >
              <div className="row wrap">
                <button className="btn small" onClick={() => setCutPlanePreset('y')}>水平</button>
                <button className="btn small" onClick={() => setCutPlanePreset('x')}>左右</button>
                <button className="btn small" onClick={() => setCutPlanePreset('z')}>前后</button>
              </div>
              <button className="btn primary" disabled={!selectedNode || !cutPlaneOn} onClick={splitSelectedObjectByPlane}>
                拆成切件 A + 切件 B
              </button>
              <div className="hint">打开平面后可用 W 移动、E 旋转；切口目前不自动封盖。</div>
            </Section>
            <Section title="结构拆分">
              <button className="btn" disabled={!selectedNode} onClick={() => splitSelectedObject('material')}>
                按材质组拆分
              </button>
              <button className="btn" disabled={!selectedNode} onClick={() => splitSelectedObject('connected')}>
                按独立壳体拆分
              </button>
              <div className="hint">
                “独立壳体”会识别同一网格里互不相连的衣服、身体或零件，分别变成可编辑组件。
              </div>
            </Section>
          </>
        )}

        <Section
          title={`材质与贴图（${materials.length}）`}
          right={(
            <label className="row object-wireframe">
              <input type="checkbox" checked={wireframe} onChange={(event) => setWireframe(event.target.checked)} />
              线框
            </label>
          )}
        >
          {materials.length === 0 ? (
            <div className="hint">添加基础形状后，这里会出现可编辑材质。</div>
          ) : materials.slice(0, 30).map((material) => (
            <div className="object-material" key={material.id}>
              <div className="row">
                <input
                  type="color"
                  value={material.color}
                  onChange={(event) => setMaterialProp(material.id, { color: event.target.value })}
                />
                <span className="grow ellipsis">{material.name}</span>
              </div>
              {material.metalness !== null && (
                <SliderRow
                  label="金属度"
                  value={material.metalness}
                  min={0}
                  max={1}
                  onChange={(value) => setMaterialProp(material.id, { metalness: value })}
                />
              )}
              {material.roughness !== null && (
                <SliderRow
                  label="粗糙度"
                  value={material.roughness}
                  min={0}
                  max={1}
                  onChange={(value) => setMaterialProp(material.id, { roughness: value })}
                />
              )}
              <div className="texture-slot-list">
                {TEXTURE_SLOTS.map((slot) => (
                  <div className="texture-slot-row" key={slot.id}>
                    <span>{slot.label}</span>
                    <label className="btn small texture-file-button">
                      {material.textures[slot.id] ? '替换' : '添加'}
                      <input
                        hidden
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/avif"
                        onChange={(event) => {
                          const file = event.target.files?.[0]
                          if (file) void setMaterialTexture(material.id, slot.id, file)
                          event.target.value = ''
                        }}
                      />
                    </label>
                    <span className="texture-name" title={material.textures[slot.id]}>
                      {material.textures[slot.id] || '未设置'}
                    </span>
                    {material.textures[slot.id] && (
                      <button
                        type="button"
                        className="icon-btn texture-clear"
                        title={`移除${slot.label}贴图`}
                        onClick={() => clearMaterialTexture(material.id, slot.id)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Section>
      </div>
    </aside>
  )
}
