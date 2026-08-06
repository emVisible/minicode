// 全局 JSX 命名空间 shim: 根 tsconfig 用 jsx "preserve"(经典工厂, 兼容计划文件 @jsx 编译),
// 而 @types/react 19 的 JSX 是模块级 (React.JSX), 需要桥接回全局 JSX 供 tsc 检查 React 组件。
// 注意: 本文件不得与 src/influx/jsx.d.ts 同属一个 TS 程序(全局 JSX 会重复声明)。

import type * as React from "react"

declare global {
  namespace JSX {
    type Element = React.JSX.Element
    type ElementType = React.JSX.ElementType
    interface ElementChildrenAttribute {
      children: unknown
    }
    interface IntrinsicElements extends React.JSX.IntrinsicElements {}
  }
}
