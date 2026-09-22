/**
 * 可选功能装载器：把「可选 peer、插件或包内模块失败时只跳过本功能」这条契约集中在一处。
 *
 * Rule: Pi 扩展对外部依赖与可选模块一律软依赖。导入失败、工厂失败或缺少约定导出时，
 * 记录上下文前缀的日志并跳过该功能，绝不向调用方抛出。
 *
 * Guarantee: 任何被装载的功能返回 undefined 或抛错，都不影响同包其他功能与其他包。
 */

import { logFailure } from "./extension-log.ts";

export type FeatureFailureReporter = (name: string, error: unknown) => void;

export type OptionalFeatureLoader = {
  /** 产出功能模块；失败返回 undefined。 */
  import<T>(name: string, load: () => Promise<T>): Promise<T | undefined>;
  /** 执行功能模块导出的 `default(pi)`；失败返回 false。 */
  activate<TModule extends OptionalFeatureModule>(
    name: string,
    load: () => Promise<TModule>,
    pi: Parameters<NonNullable<TModule["default"]>>[0],
  ): Promise<boolean>;
};

type OptionalFeatureModule = { default?: (pi: never) => unknown };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFeatureLoader(report?: FeatureFailureReporter): OptionalFeatureLoader {
  const reportFailure = (name: string, error: unknown): void => {
    if (report) {
      report(name, error);
      return;
    }
    logFailure(`optional-feature/${name}`, `不可用，已跳过：${errorMessage(error)}`);
  };

  return {
    async import<T>(name: string, load: () => Promise<T>): Promise<T | undefined> {
      try {
        return await load();
      } catch (error) {
        reportFailure(name, error);
        return undefined;
      }
    },
    async activate<TModule extends OptionalFeatureModule>(
      name: string,
      load: () => Promise<TModule>,
      pi: Parameters<NonNullable<TModule["default"]>>[0],
    ): Promise<boolean> {
      const module = await this.import(name, load);
      const activate = module?.default as ((pi: unknown) => unknown) | undefined;
      if (typeof activate !== "function") {
        reportFailure(name, new Error("未导出有效入口"));
        return false;
      }
      try {
        await activate(pi);
        return true;
      } catch (error) {
        reportFailure(name, error);
        return false;
      }
    },
  };
}
