# 凹咕快讯 · 图片生成（GitHub Pages 部署包）

这个文件夹整个上传到 GitHub 仓库即可作为静态站点，`index.html` 就是入口。

## 部署步骤（网页版，不用命令行）

1. 登录 GitHub，右上角 `+` → **New repository**
   - Repository name：随意，例如 `aogu-quicknews`
   - 可见性：**Public**（免费账号的 Pages 只支持 public 仓库）
   - 勾选 **Add a README file** → Create repository
2. 进入仓库 → **Add file** → **Upload files**
   - 把这个文件夹里的 `index.html` 和 `README.md` 一起拖进去
   - 点 **Commit changes**
3. 仓库 → **Settings** → 左侧 **Pages**
   - Source 选 **Deploy from a branch**
   - Branch 选 `main`，目录选 `/ (root)` → **Save**
4. 等 30–60 秒刷新该页面，顶部会出现：
   `Your site is live at https://<用户名>.github.io/<仓库名>/`
5. 手机浏览器打开这个地址 → 可「添加到主屏幕」，之后像 App 一样用。

## 地址规则

| 情况 | 得到的地址 |
| --- | --- |
| 仓库叫 `aogu-quicknews` | `https://<用户名>.github.io/aogu-quicknews/` |
| 仓库叫 `<用户名>.github.io` | `https://<用户名>.github.io/` |

## 说明

- 部署后是 **https**，所以「保存 PNG」会优先调起系统分享面板，iOS 可直接「存储图像」到相册。
- 在微信里打开时，分享接口不可用，会自动降级为「长按图片保存」。
- 纯静态、无后端、无外部请求，离线（缓存后）也能用。
- 文件名保持 `index.html` 不要改，改了首页就 404。
