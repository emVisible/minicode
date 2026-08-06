type InfluxElement = { type: unknown; props: Record<string, any> }

declare namespace JSX {
  type Element = InfluxElement
  interface ElementChildrenAttribute {
    children: unknown
  }
  type IntrinsicElements = Record<string, any>
}
