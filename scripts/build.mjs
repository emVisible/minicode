// 构建单文件可执行包(dist/minicode.mjs)
// - 全量内联(ink/react/scheduler/yoga), 仅 node 内置模块外部化
// - system react-devtools-core 只是 ink 在 DEV=true 时的可选依赖, 构建期替换为空模块
//   (DEV 未开启时该模块绝不会被加载, 见 ink/build/reconciler.js)
// - 输出带 shebang, 可直接 node dist/minicode.mjs 运行
// - banner 注入版本标记(与 package.json 保持单一来源)

import { build } from "esbuild"
import { mkdirSync, readFileSync, chmodSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const distDir = join(root, "dist")
mkdirSync(distDir, { recursive: true })

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

await build({
  entryPoints: [join(root, "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(distDir, "minicode.mjs"),
  banner: { js: `#!/usr/bin/env node\n/* minicode v${pkg.version} ${new Date().toISOString().slice(0, 10)} */` },
  metafile: false,
  logLevel: "info",
  plugins: [
    {
      name: "stub-devtools-core",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "devtools-stub",
        }))
        build.onLoad({ filter: /.*/, namespace: "devtools-stub" }, () => ({
          contents: "export default { initialize() {}, connectToDevTools() {} };\n",
          loader: "js",
        }))
      },
    },
  ],
})

chmodSync(join(distDir, "minicode.mjs"), 0o755)
console.log("✓ dist/minicode.mjs built")