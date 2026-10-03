# UtilityLab

`UtilityLab` 是实验性工具项目的统一迭代管理仓库。

## 目录约定

```text
UtilityLab/
├─ <ProjectName>/          # 一个实验工具对应一个独立项目目录
├─ shared/<库名>/           # 跨项目共享库，需记录依赖方与对外接口
├─ scripts/git/            # 仓库级 Git 检查脚本与受版本控制的 hooks
├─ .github/workflows/      # CI：强制执行仓库策略
├─ .gitignore              # 敏感信息、数字资产和本地产物排除规则
├─ .gitattributes          # 行尾与二进制属性
├─ .policy-allow           # 策略豁免登记（须写明来源、许可证、必要性）
├─ CLAUDE.md               # 供编码代理阅读的硬性约束摘要
├─ LICENSE                 # MIT
└─ RULES.md                # 仓库协作与内容管理规则
```

仓库根目录只放置仓库级说明、规则与公共管理工具。项目源码、配置、文档、
测试和迁移产物都应放在对应项目目录内。

## 当前项目

- [EffectLab](EffectLab/README.md)：浏览器端程序化特效编辑器。
- [CharacterForgeLab](CharacterForgeLab/README.md)：融合人物装配、骨骼动画与单物体建模的三维工作台。

## 开始工作

1. 阅读 [RULES.md](RULES.md)。

2. 安装 Git hooks（每次克隆后执行一次）：

   ```bash
   powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/git/install-hooks.ps1
   ```

   该脚本把 `core.hooksPath` 指向 `scripts/git/hooks`，此后每次 `git commit`
   都会自动运行策略检查。

3. 为新实验创建独立项目目录。

4. 需要手动检查时运行：

   ```bash
   powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/git/check-repository-policy.ps1
   ```

   已安装 PowerShell 7 的环境可以把 `powershell -NoProfile -ExecutionPolicy Bypass`
   换成 `pwsh -NoProfile`。

## 策略检查做什么

检查对象是 **Git 索引**（即将提交的内容），而不是工作区文件——工作区副本可能
已被改动或删除，只有索引内容才会真正进入提交。

| 规则 | 含义 | 可否豁免 |
| --- | --- | --- |
| `size` | 单文件超过 50 MB | **不可** |
| `asset` | 数字创意资产、归档、编译产物 | 可 |
| `secret-name` | 文件名疑似凭据或私钥 | 可 |
| `secret-content` | 文本内容出现明文凭据特征 | 可 |
| `force-added` | 被 `.gitignore` 排除却仍被追踪 | 可 |

豁免一律登记在 [.policy-allow](.policy-allow) 中，语法与示例见该文件注释。

CI 在推送与 PR 上重跑同一脚本，因此本地 `git commit --no-verify` 只能推迟、
不能绕过检查。

## 维护提示

- `.gitignore` 与 `scripts/git/check-repository-policy.ps1` 中的扩展名清单
  必须保持同步，修改一处时同步另一处。
- `scripts/git/*.ps1` 必须保存为 **UTF-8 with BOM**。Windows PowerShell 5.1
  会把无 BOM 的 `.ps1` 按系统 ANSI 代码页解码，导致中文字符串字面量损坏。
- `scripts/git/hooks/` 下的文件必须是 LF 行尾，否则 `sh` 会报
  `bad interpreter`；`.gitattributes` 已作约束。

> 当前的 `AnimotionHub/` 含有约 38 GB 数字创意资产，整体保留在本地，
> 不进入 Git 管理。后续若需公开其中的纯代码，应先整理并单独审核，
> 详见 [RULES.md](RULES.md) 第 6 节。
