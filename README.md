# TransBook

通过 DeepSeek API 翻译整本书的 Web 应用。翻译任务在本地后端执行，全部数据落盘持久化，不用数据库。

## 功能

- **上传翻译**：支持 epub / txt（txt 自动识别编码、自动分章），自动生成可编辑的人名/地名/术语表，按章并发翻译，支持断点续翻、单章重译、多 API Key 并发叠加
- **小说抓取**：搜索 / 浏览 syosetu、kakuyomu 排行榜，一键抓取整本，支持增量更新
- **阅读器**：在线阅读原文/译文，支持阅读进度、书签、全书搜索
- **听书**：edge-tts 逐句朗读，句级高亮跟读，音色/倍速可调，合成结果全局缓存
- **书架管理**：分组整理、翻译队列、导出 epub/txt
- **WebDAV 书库**：可把整个书架以 EPUB 形式暴露给局域网阅读软件（如静读天下、KyBook）
- **自动更新**：检测 GitHub 远端更新，确认后自动构建并热更新（Docker 部署）

## 快速开始

前置依赖：[uv](https://docs.astral.sh/uv/)、[Bun](https://bun.sh/)

```bash
uv sync          # 安装 Python 依赖（根目录执行）
bun install      # 安装 JS 依赖（根目录执行）
./start.sh       # 一键启动：构建前端后由后端托管，仅 8300 一个端口，Ctrl+C 停止
```

打开 http://localhost:8300 ，在「设置」页填入 DeepSeek API Key 即可开始使用。

端口被占用时可以换端口启动：`BACKEND_PORT=8301 ./start.sh`

## Docker 部署

无需安装 uv / Bun，前端构建在镜像内完成。

```bash
docker compose up -d --build
```

- 运行数据通过绑定挂载落在宿主机 `./backend/data/`，重建容器数据不丢
- 容器监听 `0.0.0.0`，局域网设备访问 `http://<宿主机IP>:8300`
- WebDAV 书库在「设置」页开启后位于 `http://<宿主机IP>:8300/webdav/`（无认证，勿暴露公网）
- 换端口：编辑 `docker-compose.yml` 的 `ports`，如 `"8301:8300"`
