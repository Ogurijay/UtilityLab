# CharacterForgeLab

CharacterForgeLab 是统一的人物与物体编辑器。原 CharacterLab、CharacterStudio V4
和旧 CharacterStudio 已合并到本目录，前端、Python 服务、Blender/Unreal 桥接、
系统资产、工作区与测试不再散落在 AnimotionHub。

网页入口继续使用：

```text
http://127.0.0.1:8788/CharacterStudio/
```

`/CharacterStudio/` 只是兼容旧收藏与资产 URL 的网页路由，不再对应一个独立项目目录。

## 启动

```powershell
cd CharacterForgeLab
npm install
npm run build
npm run serve
```

也可以双击本目录的 `启动服务.bat`。开发模式使用：

```powershell
npm run serve
npm run dev
```

生产服务使用 8788 端口；Vite 开发服务使用 8617 端口，并把 API、系统资产和参考姿势
数据代理到 8788。

## 单项目结构

```text
CharacterForgeLab/
├─ src/                 React + Three.js 编辑器
├─ server/              Python API、任务调度、Blender/Unreal 桥接
├─ runtime/
│  ├─ data/             资产注册表、骨架与参考姿势配置
│  ├─ library/          Manny、UEFN、动画和用户受管资产
│  ├─ workspaces/       人物项目
│  ├─ jobs/             后台任务结果
│  ├─ recipes/          旧配方只读迁移数据
│  ├─ .tasks/           Unreal 等外部任务
│  └─ .trash/           可恢复回收区
├─ tests/server/        API、数据与任务调度测试
├─ docs/                设计说明
└─ dist/                前端生产构建
```

## 核心能力

- 真实 UE5 Manny Simple 与 UEFN Mannequin 基准角色。
- 经骨架签名验证的原始姿势、T Pose 与 A Pose。
- 静态头雕替换、独立头部组件和颈部衔接调整。
- 静态人物基础四权重蒙皮及可选 Blender 自动权重精修。
- Manny/UEFN 系统动画、用户动画导入、重定向和单骨骼关键帧。
- 多网格装配、骨骼挂接、部件显隐和角色 GLB 导出。
- 只针对网格的单物体编辑：贴图、合并、切面/材质/独立壳体拆分及基础顶点雕刻。
- 工作区保存、资产库保存、GLB 导出和撤销/恢复。

程序生成的四条错误内置动画已经删除；动画列表只显示真实系统资产或用户导入资产。

## 技术基线

- Three.js：`0.185.1`
- React：19
- Vite：6
- Python：本机轻量 HTTP/API 服务
- Blender：可选后台自动蒙皮与 FBX 转换

浏览器基础蒙皮和顶点雕刻用于快速编辑；手指、肩部、面部等高质量权重仍建议使用
Blender 后台精修。
