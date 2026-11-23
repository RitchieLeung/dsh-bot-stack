import { registerHooks } from 'node:module';

const STUBS = {
  '@deepseek-ai/dsh-tools': `
    export function defineTool(def) {
      const params = def.parameters && !def.parameters.type
        ? {
            type: 'object',
            additionalProperties: false,
            required: Object.entries(def.parameters).filter(([, spec]) => spec?.required).map(([k]) => k),
            properties: Object.fromEntries(
              Object.entries(def.parameters).map(([k, spec]) => {
                const { required: _r, ...rest } = spec || {};
                return [k, rest];
              }),
            ),
          }
        : (def.parameters || { type: 'object', properties: {} });
      return { ...def, parameters: params };
    }
  `,
  '@deepseek-ai/dsh-llm': `
    export class BlockAssembler {}
    export class HarnessError extends Error {}
    export class LlmAdapter {}
    export class LlmError extends Error {}
    export const createUserMessage = x => x;
  `,
  'deep-view/core': `
    export const checkShownView = () => ({ title: '', view: {}, interactive: false });
    export const showViewDescription = () => 'show_view';
    export const showViewParameters = {};
  `,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(STUBS, specifier)) {
      return { url: `stub:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('stub:')) {
      const key = url.slice('stub:'.length);
      return { format: 'module', source: STUBS[key], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
