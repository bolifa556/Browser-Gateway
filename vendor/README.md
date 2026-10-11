# Build assets / 构建依赖

## Google Chrome

The current Dockerfile uses **Google Chrome Stable 155.0.8059.39, Linux amd64**.
The installer must be available as `vendor/chrome.deb`; it is deliberately
excluded from Git. It is mounted during the image build and is not retained as
an installer in the runtime image.

当前 Dockerfile 使用 **Google Chrome Stable 155.0.8059.39，Linux amd64**。
安装包放在 `vendor/chrome.deb`，不提交 Git。构建时通过临时挂载安装，运行
镜像不保留安装包文件。

```sh
sh scripts/prepare-vendor.sh
# Optional: use an official archive URL for the exact pinned version.
CHROME_DEB_URL='<https-url-to-the-pinned-package>' sh scripts/prepare-vendor.sh
```

The helper reuses an existing verified file. Otherwise it downloads from
[Google's official distribution endpoint](https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb)
or `CHROME_DEB_URL` and verifies the checksum before replacing the local asset.
The official `current` URL is mutable: if it serves a newer version, obtain the
exact pinned package or review a deliberate browser upgrade together with the
Dockerfile and manifest. A mismatched download is rejected, not accepted silently.

脚本优先复用已验证的安装包，否则从 Google 官方地址或 `CHROME_DEB_URL`
下载，并在替换本地文件前校验 SHA-256。官方 `current` 地址会随版本更新；
若返回新版，请提供固定版本安装包，或同时审查 Dockerfile 与校验清单后进行
明确的版本升级。脚本不会自动接受校验不一致的文件。

## acme.sh

- Version / 版本: **3.1.6**
- Upstream / 上游: [acmesh-official/acme.sh](https://github.com/acmesh-official/acme.sh)
- Purpose / 用途: optional ACME certificate issuance and renewal / 可选 ACME 证书签发与续期
- License / 许可证: GNU GPL v3; see [acme-LICENSE.md](acme-LICENSE.md).

## Verification / 校验

Run from the repository root / 在仓库根目录执行：

```sh
sha256sum --check vendor/checksums.sha256
```

Hashes in [checksums.sha256](checksums.sha256) identify the pinned files. The
browser package remains subject to Google's licensing terms; the manifest does
not grant redistribution rights.

[checksums.sha256](checksums.sha256) 标识当前固定依赖文件。浏览器安装包仍
遵循 Google 的许可条款，校验清单本身不授予重新分发权。
