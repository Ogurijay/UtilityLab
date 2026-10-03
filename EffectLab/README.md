# EffectLab · 特效工坊

**成熟度：prototype（原型）**

浏览器端的 UE 特效烘焙台。在 three.js 里用 GPU 粒子模拟做出特效，
再逐帧离屏烘焙成 Unreal Engine 能直接使用的 SubUV 图集与参数规格。
纯前端，无后端，导出物只落到本地磁盘。

> **当前进度：M1 完成**（模拟 + 渲染 + 参数编辑）。
> 烘焙导出（M2）尚未实现，见下方[路线图](#路线图)。

## 为什么产物是贴图而不是场景

UE 消费不了 three.js 的粒子系统本身。所以本项目的交付物不是「特效」，
而是 **UE 能直接吃的贴图资产 + 参数规格**：

| 出口 | 产物 | UE 侧怎么用 | 状态 |
| --- | --- | --- | --- |
| Flipbook 图集 | `N×M` SubUV PNG + `effect.json` | Niagara Sprite 材质设 SubImages_H/V | M2 |
| 通道打包灰度图集 | R=密度 G=发光 B=遮罩 A=alpha | 材质里用 Ramp 上色，规避 RGBA8 丢 HDR | M2 |
| Motion Vector 图集 | 帧间位移贴图 | Flipbook 插值，少帧看起来像多帧 | M3 |
| 六向光照图集 | 2 张 RGBA，存 ±X/±Y/±Z 受光 | UE5 Six-Way Lightmap 烟雾材质 | M3 |
| 点缓存位置贴图 | u=粒子 id, v=帧 | Niagara 采样贴图重建粒子 | M4 |
| VAT 顶点动画贴图 | 位置+法线贴图 + 合并网格 | 自建 VAT 材质 | M4 |

## 运行方式

```bash
npm install
npm run dev        # 开发服务器，默认 http://localhost:8618
npm run build      # 类型检查 + 生产构建（输出 dist/）
```

> 端口在 `vite.config.ts` 里改。8617 已被 CharacterForgeLab 占用，
> 本机 5173 处于 Windows 保留端口段，故用 8618。

需要浏览器支持 **WebGL2 + `EXT_color_buffer_float`**（浮点渲染目标）。
缺任一项时视口会直接给出提示而不是黑屏。

## 现在能做什么

| 模块 | 能力 |
| --- | --- |
| 粒子模拟 | 自研 GPGPU 求解器：位置 / 速度 / 属性三张浮点贴图经 MRT 一次写出、双缓冲 ping-pong，半隐式欧拉、固定步长 |
| 发射器 | 点 / 球 / 盒 / 圆盘 / 锥；连续发射或定时爆发；发射率、锥半角、初速、径向速度、寿命 / 尺寸 / 速度抖动、自转 |
| 力场 | 重力、随生命衰减的浮力、指数阻力、恒风、无散度 curl 噪声湍流、涡流、点吸引 / 排斥 |
| 碰撞 | 地面平面 + 球体障碍，弹性、摩擦、碰撞消亡概率 |
| 生命曲线 | 尺寸 / 透明度 / 溶解阈值三条可拖拽曲线 + 颜色渐变条，全部随归一化生命求值 |
| 材质 | 相加 / 透明 / 预乘三种混合；程序化精灵与无缝噪声；噪声溶解（阈值随生命推进）；亮度倍数 |
| 贴图 | 导入自己的图片当精灵或溶解噪声，存 IndexedDB，仓库里不留任何图片文件 |
| 预设 | 5 个内置预设（火焰 / 烟雾 / 火星 / 魔法漩涡 / 爆炸），本地保存，JSON 导入导出 |
| 播放控制 | 播放 / 暂停 / 单步 / 从 t=0 重跑，实时统计 |

## 技术要点

### 确定性是硬约束

烘焙的前提是「同参数烘两次逐像素一致」，所以模拟层从一开始就按可复现设计：

- **时间只通过 `step(dt)` 推进**，求解器不读挂钟；预览层把真实帧时间累加成固定步长再喂进去。
- **随机数全部走整数 hash**（`uhash` 雪崩函数），种子来自 `(粒子 id, 发射周期, 全局 seed)`，
  不使用任何 GPU 端不确定的行为。
- **出生时机是解析式而非累加计数器**：由当前时间反推粒子处于第几个发射周期，
  因此从任意时刻重跑都落在同一条轨迹上。

已实测：同一预设跑两遍 90 帧，位置缓冲区的 FNV 哈希完全一致。

### 色彩空间

`THREE.ColorManagement` 被关闭，`outputColorSpace` 设为线性，
所有传输函数在本项目的着色器里手工处理（贴图与渐变按 sRGB 存、采样时解码到线性，
输出端由 `uOutputSRGB` 决定是否再编码）。这样预览与将来的离线烘焙之间
不会出现两套隐式转换——M2 烘焙需要线性数据时把该开关置 0 即可。

### 程序化资产

仓库规则禁止提交贴图，因此内置的 5 种精灵（烟团 / 火星 / 火舌 / 冲击环 / 软圆）
与 3 种噪声（FBM / Worley / Ridged）全部在运行时用 GPU 生成。
噪声使用带精确周期的格点 hash，四边严格无缝。

## 目录结构

```text
EffectLab/
├─ index.html / vite.config.ts / tsconfig.json
└─ src/
   ├─ core/
   │  ├─ engine.ts          # 渲染器、相机、辅助体、固定步长主循环
   │  ├─ glsl/              # 噪声与随机、求解器、精灵着色器、程序化贴图生成
   │  ├─ sim/gpuSim.ts      # MRT 双缓冲 GPGPU 求解器
   │  ├─ render/            # 实例化 billboard 渲染
   │  └─ material/          # 曲线 / 渐变 ramp、程序化贴图、用户贴图
   ├─ app/engineHandle.ts   # 引擎单例句柄（供顶栏等调用）
   ├─ store/editor.ts       # zustand 编辑器状态
   ├─ db/textureDb.ts       # IndexedDB：贴图与本地预设
   ├─ presets/              # 内置预设（纯 JSON 结构，无资产）
   └─ components/           # React 界面：顶栏、资源栏、视口、检查器、曲线 / 渐变编辑器
```

## 已知限制

- **还不能导出图集**。当前只有实时预览与参数编辑，烘焙器是 M2 的内容。
- **透明混合不做深度排序**。`additive` 与 `premultiplied` 与顺序无关，
  但 `alpha` 模式下粒子间可能出现穿插错误。
- **没有软粒子**（与场景深度的相交淡出）。烘焙场景里没有其它几何体，
  影响不大，但视口里粒子穿过地面时边缘是硬的。
- **RGBA8 精度是硬顶**。亮度倍数目前只影响预览；M2 会做归一化并把倍数写进
  `effect.json`，真正的 HDR 输出要等 M4 上 16bit / EXR。
- **曲线 ramp 为 512×1 的 8 位贴图**，极缓慢的淡出可能有轻微条带。
- **单发射器**。多发射器叠加、拖尾 ribbon、网格发射都在路线图后段。
- 测试用的图片放本地任意目录即可，仓库 `.gitignore` 已全局排除 `*.png` 等格式。

## 路线图

- **M0 ✅** 工程骨架
- **M1 ✅** GPU 求解器 + 力场 + 碰撞 + 生命曲线 + 精灵渲染 + 贴图 / 噪声接入
- **M2** 烘焙器：确定性逐帧步进、`N×M` 图集、tile padding、通道打包、
  `图集 PNG + effect.json + import_effect.py` 三件套下载
- **M3** Motion Vector + 六向光照图集 + UE 侧导入脚本完善
- **M4** 点缓存位置贴图 / VAT / 拖尾 ribbon / 刚体碎块（可选依赖 rapier）

## 外部代码来源

`src/core/glsl/noise.ts` 中的 `snoise(vec3)` 为 webgl-noise 项目的 3D simplex noise
（Ashima Arts / Stefan Gustavson，作者 Ian McEwan，**MIT 许可**，
<https://github.com/ashima/webgl-noise>）。其余 GLSL 与 TypeScript 代码为本项目实现。
