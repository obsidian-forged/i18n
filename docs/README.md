# Obsidian i18n 文档站

这个目录是 `obsidian-i18n` 的 Mintlify 文档站根目录。

在线入口：[简体中文](https://eondr.mintlify.app/introduction) · [English](https://eondr.mintlify.app/en/introduction)

## 文档目标

- 面向插件使用者，说明安装、提取、翻译、应用、还原、Cloud 下载和 GitHub 发布流程
- 面向文档维护者，约束文档必须以源码和已验证行为为准

## 语言结构

- 根目录下的公开 MDX 页面是简体中文主文
- `docs/en/` 是英文镜像
- 公开页面必须保持同一 slug、同一信息架构、同一导航层级

当前站点语言配置在 `docs/docs.json` 中：

- 默认语言：`zh-Hans`
- 英文镜像：`en`

## 开发命令

从仓库根目录进入 `docs/` 后执行：

```bash
cd docs
npx mint dev
npx mint validate
npx mint broken-links
```

`docs.json` 将 `/`、`/index` 跳转至 `/introduction`，将 `/en`、`/en/index` 跳转至 `/en/introduction`；中英文共用对应的导航页面。

## 维护硬规则

- 中文页是事实主文，英文页必须同步镜像
- 新增任何公开页面时，必须同时新增中文页和 `docs/en/` 对应英文页
- 新增公开页面后，必须同步更新 `docs/docs.json` 导航
- 文档里的 UI 路径、按钮名、标签名、文件格式、目录结构必须来自真实源码或已验证行为
- 不要发明不存在的英文 UI 名称；如果当前源码里的实际标签是中文，英文文档也直接写中文标签并用反引号包裹
- 不要把插件译文语言码（如 `zh-cn`）和文档站语言配置（如 `zh-Hans`）混用

## 术语基线

- 产品名：`Obsidian i18n`
- Obsidian 已安装插件列表显示名：`I18N`
- 管理中心：`i18n 管理中心`
- 管理中心顶部标签：`插件`、`主题`、`管理`、`自动化`、`鸣谢`
- Cloud 视图顶部标签：`社区目录`、`探索资源`、`管理中心`
- 设置页标签：`综合设置`、`RE 配置`、`AST 配置`、`沉浸翻译`、`语言模型`、`共建生态`

## 写作要求

- 用陈述事实的句子，不写臆测性文案
- 不写“通常 / 大概 / 可能 / 一般 / 16+ / under two minutes / JSON pack”这类会让事实失真的表述
- 涉及命令入口不稳定时，优先写稳定入口，例如侧边栏图标、顶部工具栏按钮、固定标签页
