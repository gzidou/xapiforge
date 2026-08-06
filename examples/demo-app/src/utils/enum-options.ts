/**
 * 枚举 → 选项 UI helper（UI 关心的事，业务项目自带）
 *
 * 把 string literal union 枚举转成 v-select / cascader 选项。
 * 漏一项或字面量拼错立刻 tsc 报错（mapped type 强制完整性）。
 *
 * @example
 *   const opts = toOptions<PlatformType>({
 *     "Iso(Iso)=1": "iOS",
 *     "Android(Android)=2": "Android",
 *   });
 *
 *   <select v-model="form.platform">
 *     <option v-for="o in opts" :key="o.value" :value="o.value">{{ o.label }}</option>
 *   </select>
 */
export function toOptions<T extends string>(labels: { readonly [K in T]: string }): ReadonlyArray<{
  value: T;
  label: string;
}> {
  return (Object.entries(labels) as [T, string][]).map(([value, label]) => ({
    value,
    label,
  }));
}
