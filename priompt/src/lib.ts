// TODO: add an onExclude hook. i think it should be able to do whatever, and whenever it is executed, we have a promise to re-render the whole thing afterwards. the idea is that when some things are excluded we want to actually do something more advanced than just excuding certain parts (eg summarize or something)


// TODO: add an IDE plugin or something that renders the prompt when you hover over it (and has a slider for the priority)

import { ChatCompletionRequestMessage, ChatCompletionFunctions, ChatCompletionResponseMessage, CreateChatCompletionResponse, Content, StreamChatCompletionResponse, } from './openai';
import { CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT, CHATML_PROMPT_EXTRA_TOKEN_COUNT_LINEAR_FACTOR, } from './openai';
import { OpenAIMessageRole, PriomptTokenizer, numTokensForImage } from './tokenizer';
import { BaseProps, Node, ChatPrompt, Empty, First, RenderedPrompt, PromptElement, Scope, FunctionDefinition, FunctionPrompt, TextPrompt, ChatAndFunctionPromptFunction, ChatPromptMessage, ChatUserSystemMessage, ChatAssistantMessage, ChatFunctionResultMessage, Capture, OutputHandler, PromptProps, CaptureProps, BasePromptProps, ReturnProps, Isolate, RenderOutput, RenderOptions, PromptString, Prompt, BreakToken, PromptContentWrapper, PromptContent, ChatImage, ImagePromptContent, Config, ConfigProps, ChatToolResultMessage, SourceMap, ToolPrompt, ToolDefinition, ChatAndToolPromptToolFunction, AbsoluteSourceMap, RenderunCountTokensFast_UNSAFE } from './types';
import { NewOutputCatcher } from './outputCatcher.ai';
import { PreviewManager } from './preview';
import { statsd } from './statsd';

function getImageMimeType(bytes: Uint8Array): string {
	// Check the magic numbers
	if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
		return "image/jpeg";
	} else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
		return "image/png";
	} else if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		return "image/gif";
	} else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
		return "image/webp";
	} else {
		throw new Error("Unsupported image type");
	}
}


export function chatPromptToString(prompt: ChatPrompt): string {
	return prompt.messages.map((message) => {
		return `<|im_start|>${message.role}<|im_sep|>${message.content}<|im_end|>`;
	}).join('\n');
}
export function functionPromptToString(prompt: FunctionPrompt): string {
	return prompt.functions.map((func) => {
		JSON.stringify(func);
	}).join('\n');
}
const OPENAI_SPECIAL_TOKENS = [
	"<|im_start|>",
	"<|im_sep|>",
	"<|im_end|>",
	"<|meta_start|>",
	"<|meta_sep|>",
	"<|meta_end|>",
	"<|endoftext|>",
	"<|endofprompt|>",
	"<|endoffile|>",
	"<|startoftext|>",
	"<|fim_prefix|>",
	"<|fim_middle|>",
	"<|fim_suffix|>",
	"<|disc_score|>",
	"<|disc_sep|>",
	"<|disc_thread|>",
	"<|ipynb_marker|>",
	"<|diff_marker|>",
	"<|ghissue|>",
	"<|ghreview|>",
]
export function replaceOpenaiSpecialTokens(s: string): string {
	for (const token of OPENAI_SPECIAL_TOKENS) {
		s = s.replace(new RegExp(token, 'g'), token.replace("<|", "<").replace("|>", ">"));
	}
	return s;
}

export function isChatPrompt(prompt: RenderedPrompt | undefined): prompt is ChatPrompt {
	return typeof prompt === 'object' && !Array.isArray(prompt) && prompt.type === 'chat';
}
export function isPlainPrompt(prompt: RenderedPrompt | undefined): prompt is PromptString {
	return typeof prompt === 'string' || Array.isArray(prompt);
}
export function isPromptContent(prompt: RenderedPrompt | undefined): prompt is PromptContentWrapper {
	return typeof prompt === 'object' && !Array.isArray(prompt) && 'type' in prompt && prompt.type === 'prompt_content'
}
function isTextPromptPotentiallyWithFunctions(prompt: RenderedPrompt | undefined): prompt is ((TextPrompt & FunctionPrompt) | PromptString) {
	return (typeof prompt === 'object' && 'text' in prompt) || typeof prompt === 'string';
}
export function promptHasFunctions(prompt: RenderedPrompt | undefined): prompt is ((ChatPrompt & FunctionPrompt) | (TextPrompt & FunctionPrompt)) {
	return typeof prompt === 'object' && 'functions' in prompt && prompt.functions !== undefined;
}
export function promptHasTools(prompt: RenderedPrompt | undefined): prompt is ((ChatPrompt & ToolPrompt) | (TextPrompt & ToolPrompt)) {
	return typeof prompt === 'object' && 'tools' in prompt && prompt.tools !== undefined;
}
export function promptStringToString(promptString: PromptString): string {
	return Array.isArray(promptString) ? promptString.join('') : promptString;
}
export function promptGetText(prompt: RenderedPrompt | undefined): string | undefined {
	if (!isTextPromptPotentiallyWithFunctions(prompt)) {
		return undefined;
	}
	if (isPlainPrompt(prompt)) {
		return promptStringToString(prompt);
	}
	return promptStringToString(prompt.text);
}

function sumPromptStrings(a: PromptString, b: PromptString): PromptString {
	if (Array.isArray(a) && a.length === 0) {
		return b;
	}
	if (Array.isArray(b) && b.length === 0) {
		return a;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		// Manual array allocation and assigment is around 3x faster for small arrays (<100 elements)
		// than spreading slices, e.g. [...a.slice(0, -1), a[a.length - 1] + b[0], ...b.slice(1)];
		const result = new Array(a.length + b.length - 1);
		for (let i = 0; i < a.length - 1; i++) {
			result[i] = a[i];
		}
		result[a.length - 1] = a[a.length - 1] + b[0];
		for (let i = 1; i < b.length; i++) {
			result[a.length - 1 + i] = b[i];
		}
		return result;
	}
	if (Array.isArray(a)) {
		const result = a.slice();
		result[result.length - 1] += b;
		return result;
	}
	if (Array.isArray(b)) {
		const result = b.slice();
		result[0] = a + result[0];
		return result;
	}
	return a + b;
}

export function emptyConfig(): ConfigProps {
	return {
		maxResponseTokens: undefined,
		stop: undefined,
	};
}
// TODO: we probably want to merge based on depth-in-tree (not priority, i think)
// so that things higher up in the tree take precedence
// this is just to make sure that a component cannot affect a parent component unexpectedly
function mergeConfigsInPlace(a: ConfigProps, b: ConfigProps): ConfigProps {
	for (const key of Object.keys(b) as (keyof ConfigProps)[]) {
		if (a[key] === undefined) {
			a[key] = b[key] as any; // eslint-disable-line
		}
	}
	return a;
}

function sumPrompts(a: RenderedPrompt | undefined, b: RenderedPrompt | undefined): RenderedPrompt | undefined {
	if (a === undefined) {
		return b;
	}
	if (b === undefined) {
		return a;
	}
	// These are non-intersecting messages, so we are fine
	if ((isChatPrompt(a) && isChatPrompt(b)) || (isChatPrompt(a) && promptGetText(b) === '') || (isChatPrompt(b) && promptGetText(a) === '')) {
		const functions = (promptHasFunctions(a) ? a.functions : []).concat(promptHasFunctions(b) ? b.functions : []);
		const tools = (promptHasTools(a) ? a.tools : []).concat(promptHasTools(b) ? b.tools : []);
		const prompt: (ChatPrompt & FunctionPrompt) | (ChatPrompt & ToolPrompt) | ChatPrompt = {
			type: 'chat',
			messages: (isChatPrompt(a) ? a.messages : []).concat(isChatPrompt(b) ? b.messages : []),
			functions: functions.length > 0 ? functions : undefined,
			tools: tools.length > 0 ? tools : undefined,
		};
		return prompt;
	}
	if ((promptHasTools(a) || promptHasTools(b)) && (promptHasFunctions(a) || promptHasFunctions(b))) {
		throw new Error(`Cannot sum prompts ${a} and ${b} since you should only use tools or functions, but not both`);
	}
	if ((promptHasTools(a) || promptHasTools(b)) && (isTextPromptPotentiallyWithFunctions(a) && isTextPromptPotentiallyWithFunctions(b))) {
		const tools = (promptHasTools(a) ? a.tools : []).concat(promptHasTools(b) ? b.tools : []);
		const prompt: (TextPrompt & ToolPrompt) = {
			type: 'text',
			text: sumPromptStrings((isPlainPrompt(a) ? a : a.text), (isPlainPrompt(b) ? b : b.text)),
			tools,
		};
		return prompt;
	}
	if ((promptHasFunctions(a) || promptHasFunctions(b)) && (isTextPromptPotentiallyWithFunctions(a) && isTextPromptPotentiallyWithFunctions(b))) {
		// valid, should return TextPrompt & FunctionPrompt
		const functions = (promptHasFunctions(a) ? a.functions : []).concat(promptHasFunctions(b) ? b.functions : []);
		const prompt: (TextPrompt & FunctionPrompt) = {
			type: 'text',
			text: sumPromptStrings((isPlainPrompt(a) ? a : a.text), (isPlainPrompt(b) ? b : b.text)),
			functions,
		};
		return prompt;
	}

	if ((promptHasTools(a) && isPromptContent(b)) || (promptHasTools(b) && isPromptContent(a))) {
		throw new Error(`Cannot sum prompts ${a} and ${b} since one has tools and the other has images`);
	}

	// We should not have contentPrompts with functions in them
	if ((promptHasFunctions(a) && isPromptContent(b)) || (promptHasFunctions(b) && isPromptContent(a))) {
		throw new Error(`Cannot sum prompts ${a} and ${b} since one has a function and the other has images`);
	}

	// Sum together content with plain text
	if (isPlainPrompt(a) && isPromptContent(b)) {
		return {
			type: b.type,
			content: sumPromptStrings(a, b.content),
			images: b.images,
		}
	} else if (isPlainPrompt(b) && isPromptContent(a)) {
		return {
			type: a.type,
			content: sumPromptStrings(a.content, b),
			images: a.images,
		}
	} else if (isPromptContent(a) && isPromptContent(b)) {
		return {
			type: a.type,
			content: sumPromptStrings(a.content, b.content),
			images: (a.images ?? []).concat(b.images ?? []),
		}
	}

	if (isPlainPrompt(a) && isPlainPrompt(b)) {
		return sumPromptStrings(a, b);
	}
	throw new Error(`cannot sum prompts ${a} (${isPlainPrompt(a) ? 'string' : a.type}) and ${b} (${isPlainPrompt(b) ? 'string' : b.type})`);
}


export function createElement(tag: ((props: BaseProps & Record<string, unknown>) => PromptElement) | string, props: Record<string, unknown> | null, ...children: PromptElement[]): PromptElement {
	if (typeof tag === 'function') {
		// we scope each tag so we can add priorities to it
		return {
			type: 'scope',
			children: [tag({ ...props, children: children })].flat(),
			absolutePriority: (props && typeof props.p === 'number') ? props.p : undefined,
			relativePriority: (props && typeof props.prel === 'number') ? props.prel : undefined,
			name: (props && typeof props.name === 'string') ? props.name : undefined,
		};
	}
	if (!(typeof tag === 'string')) {
		throw new Error(`tag must be a string or a function, got ${tag}`);
	}

	switch (tag) {
		case 'scope':
			{
				return {
					type: 'scope',
					children: children.flat(),
					relativePriority: (props && typeof props.prel === 'number') ? props.prel : undefined,
					absolutePriority: (props && typeof props.p === 'number') ? props.p : undefined,
					name: (props && typeof props.name === 'string') ? props.name : undefined,
					onEject: props && typeof props.onEject === 'function' ? props.onEject as () => void : undefined,
					onInclude: props && typeof props.onInclude === 'function' ? props.onInclude as () => void : undefined,
				};
			}
		case 'br':
			{
				if (children.length > 0) {
					throw new Error(`br tag must have no children, got ${children}`);
				}
				return {
					type: 'scope',
					children: ['\n'],
					absolutePriority: (props && typeof props.p === 'number') ? props.p : undefined,
					name: (props && typeof props.name === 'string') ? props.name : undefined,
					relativePriority: (props && typeof props.prel === 'number') ? props.prel : undefined
				};
			}
		case 'config':
			{
				if (children.length > 0) {
					throw new Error(`config tag must have no children, got ${children}`);
				}
				if (props && typeof props !== 'object') {
					throw new Error(`props must be an object, got ${props}`);
				}
				let maxResponseTokens: number | 'tokensReserved' | 'tokensRemaining' | undefined = undefined;
				if (props && 'maxResponseTokens' in props && props.maxResponseTokens !== null && props.maxResponseTokens !== undefined) {
					if (typeof props.maxResponseTokens !== 'number' && props.maxResponseTokens !== 'tokensReserved' && props.maxResponseTokens !== 'tokensRemaining') {
						throw new Error(`maxResponseTokens must be a number, 'tokensReserved', or 'tokensRemaining', got ${props.maxResponseTokens}`);
					}
					maxResponseTokens = props.maxResponseTokens;
				}
				let stop: string | string[] | undefined = undefined;
				if (props && 'stop' in props && props.stop !== null && props.stop !== undefined) {
					if (!Array.isArray(props.stop) && typeof props.stop !== 'string') {
						throw new Error(`stop must be a string or an array of strings, got ${props.stop}`);
					}
					if (Array.isArray(props.stop) && props.stop.some(s => typeof s !== 'string')) {
						throw new Error(`stop must be a string or an array of strings, got ${props.stop}`);
					}
					stop = props.stop;
				}
				return {
					type: 'scope',
					children: [{
						type: 'config',
						maxResponseTokens: maxResponseTokens,
						stop: stop,
					}],
					absolutePriority: (props && typeof props.p === 'number') ? props.p : undefined,
					name: (props && typeof props.name === 'string') ? props.name : undefined,
					relativePriority: (props && typeof props.prel === 'number') ? props.prel : undefined
				};
			}
		case 'breaktoken':
			{
				if (children.length > 0) {
					throw new Error(`breaktoken tag must have no children, got ${children}`);
				}
				return {
					type: 'scope',
					children: [{
						type: 'breaktoken',
					}],
					name: (props && typeof props.name === 'string') ? props.name : undefined,
					absolutePriority: (props && typeof props.p === 'number') ? props.p : undefined,
					relativePriority: (props && typeof props.prel === 'number') ? props.prel : undefined
				};
			}
		case 'hr':
			{
				if (children.length > 0) {
					throw new Error(`hr tag must have no children, got ${children}`);
				}
				return {
					type: 'scope',
					children: ['\n\n-------\n\n'],
					name: (props && typeof props.name === 'string') ? props.name : undefined,
					absolutePriority: (props && typeof props.p === 'number') ? props.p : undefined,
					relativePriority: (props && typeof props.prel === 'number') ? props.prel : undefined
				};
			}
		case 'first':
			{
				const newChildren: Scope[] = [];
				// assert that all children are scopes
				for (const child of children.flat()) {
					if (child === null || typeof child !== 'object') {
						throw new Error(`first tag must have only scope children, got ${child}`);
					}
					if (child.type !== 'scope') {
						throw new Error(`first tag must have only scope children, got ${child}`);
					}
					newChildren.push(child);
				}
				return {
					type: 'first',
					children: newChildren,
					onEject: props && typeof props.onEject === 'function' ? props.onEject as () => void : undefined,
					onInclude: props && typeof props.onInclude === 'function' ? props.onInclude as () => void : undefined,
				};
			}
		case 'empty':
			{
				if (children.length > 0) {
					throw new Error(`empty tag must have no children, got ${children}`);
				}
				if (!props || (typeof props.tokens !== 'number' && typeof props.tokens !== 'function')) {
					throw new Error(`empty tag must have a tokens prop, got ${props}`);
				}

				return {
					type: 'scope',
					children: [{
						type: 'empty',
						tokenCount: typeof props.tokens === 'number' ? props.tokens : undefined,
						tokenFunction: typeof props.tokens === 'function' ? props.tokens as Empty['tokenFunction'] : undefined,
					}],
					absolutePriority: (typeof props.p === 'number') ? props.p : undefined,
					relativePriority: (typeof props.prel === 'number') ? props.prel : undefined,
				};
			}
		case 'isolate':
			{
				// must have tokenLimit
				if (!props || typeof props.tokenLimit !== 'number') {
					throw new Error(`isolate tag must have a tokenLimit prop, got ${props}`);
				}

				return {
					type: 'scope',
					children: [{
						type: 'isolate',
						tokenLimit: props.tokenLimit,
						cachedRenderOutput: undefined,
						children: children.flat(),
					}],
					absolutePriority: (typeof props.p === 'number') ? props.p : undefined,
					relativePriority: (typeof props.prel === 'number') ? props.prel : undefined,
					name: (props !== null && typeof props.name === 'string') ? props.name : undefined,
				};
			}
		case 'capture':
			{
				if (children.length > 0) {
					throw new Error(`capture tag must have no children, got ${children}`);
				}
				if (!props || ('onOutput' in props && typeof props.onOutput !== 'function')) {
					throw new Error(`capture tag must have an onOutput prop that's a function, got ${props}`);
				}
				if ('onStream' in props && typeof props.onStream !== 'function') {
					throw new Error(`capture tag must have an onStream prop and it must be a function, got ${props}`);
				}


				return {
					type: 'scope',
					children: [{
						type: 'capture',
						onOutput: ('onOutput' in props && props.onOutput !== undefined) ? props.onOutput as OutputHandler<ChatCompletionResponseMessage> : undefined,
						onStream: ('onStream' in props && props.onStream !== undefined) ? props.onStream as OutputHandler<AsyncIterable<ChatCompletionResponseMessage>> : undefined,
					}],
					absolutePriority: (typeof props.p === 'number') ? props.p : undefined,
					relativePriority: (typeof props.prel === 'number') ? props.prel : undefined,
					name: (props !== null && typeof props.name === 'string') ? props.name : undefined,
				};
			}
		case 'image': {
			if (!props || !('bytes' in props) || !(props.bytes instanceof Uint8Array)) {
				throw new Error(`image tag must have a bytes prop that's a Uint8Array, got ${props}`);
			}
			if (!('dimensions' in props) || typeof props.dimensions !== 'object' || (!props.dimensions) || !('width' in props.dimensions) || !('height' in props.dimensions) ||
				typeof props.dimensions.width !== 'number' || typeof props.dimensions.height !== 'number') {
				throw new Error(`image tag must have a dimensions prop that's an object with width and height, got ${props}`);
			}

			if (!(props.detail === 'low' || props.detail === 'high' || props.detail === 'auto')) {
				throw new Error(`image tag must have a detail prop that's either low, high, or auto, got ${props}`);
			}
			return {
				type: 'image',
				bytes: props.bytes,
				dimensions: {
					width: props.dimensions.width,
					height: props.dimensions.height,
				},
				detail: props.detail
			}

		}
		default:
			throw new Error(`Unknown tag ${tag}`);
	}
}
export function Fragment({ children }: { children: PromptElement[]; }): PromptElement {
	// merge all the lists
	return children.flat();
}



const shouldPrintVerboseLogs = () => process.env.NODE_ENV === 'development' && process.env.PRINT_PRIOMPT_LOGS === "true";
const isDev = () => process.env.NODE_ENV === 'development';
// priority level if it is not set becomes 1e9, i.e. it is always rendered
export const BASE_PRIORITY = 1e9;

export async function render(elem: PromptElement, options: RenderOptions): Promise<RenderOutput> {

	// TODO: we need to performance optimize this.
	// the problem is if there are a lot of scopes.
	// the linear search, even though it caches results, is slow because the traversal over tree is quite slow
	// additionally, the linear search is surprisingly inaccurate, because tokens apparently cross boundaries more often
	// than you'd think
	// the binary search is slow because it needs to do a lot of passes
	// i'm not sure what the right solution is! it's possible that the correct approach is just that priompt is too slow to be used for every single line of a file if the file has more than 10K lines
	// one idea is to just force the user to have coarse scopes
	// another idea is to implement this in Rust, and use the napi-rs library to call it from JS. in rust, implementing this would be trivial, because we would actually have a good data structure and memory management and parallelism (i think)

	// return renderBackwardsLinearSearch(elem, options);
	return await renderBinarySearch(elem, options);
}

export async function renderPrompt<
	ReturnT,
	PropsT extends object
>({
	prompt,
	props,
	renderOptions,
}: {
	prompt: Prompt<PropsT, ReturnT>;
	props: PropsT;
	renderOptions: RenderOptions;
}): Promise<RenderOutput> {
	const baseProps: BasePromptProps<PropsT> = props;

	const returnProps: ReturnProps<ReturnT> = {
		onReturn: async () => { },
	};

	const realProps: PromptProps<PropsT, ReturnT> = {
		...baseProps,
		...returnProps,
	} satisfies PromptProps<PropsT, ReturnT>;

	let promptElement = prompt(realProps);
	if (promptElement instanceof Promise) {
		promptElement = await promptElement;
	}

	return await render(promptElement, renderOptions);
}


// returns the highest-priority onOutput call
// may throw
export async function renderun<
	ReturnT,
	PropsT extends object
>({
	prompt,
	props,
	renderOptions,
	modelCall,
	loggingOptions,
	renderedMessagesCallback = (messages: ChatCompletionRequestMessage[]) => { },
}: {
	prompt: Prompt<PropsT, ReturnT>;
	props: Omit<PropsT, "onReturn">;
	renderOptions: Omit<RenderOptions, "countTokensFast_UNSAFE"> & { countTokensFast_UNSAFE?: RenderunCountTokensFast_UNSAFE };
	renderedMessagesCallback?: (messages: ChatCompletionRequestMessage[]) => void
	modelCall: (
		args: ReturnType<typeof promptToOpenAIChatRequest>
	) => Promise<{ type: "output", value: CreateChatCompletionResponse } | { type: "stream", value: AsyncIterable<ChatCompletionResponseMessage> } | { type: "streamResponseObject", value: AsyncIterable<StreamChatCompletionResponse> }>;
	loggingOptions?: {
		promptElementRef?: { current: PromptElement | undefined };
		renderOutputRef?: { current: RenderOutput | undefined };
	}
}): Promise<ReturnT> {
	// create an output catcher
	const outputCatcher = NewOutputCatcher<ReturnT>();

	const baseProps: Omit<BasePromptProps<PropsT>, "onReturn"> = props;

	const returnProps: ReturnProps<ReturnT> = {
		onReturn: (x) => outputCatcher.onOutput(x),
	};

	// this is fine because onOutput will get overridden
	const realProps: PromptProps<PropsT, ReturnT> = {
		...baseProps,
		...returnProps,
	} as PromptProps<PropsT, ReturnT>;

	PreviewManager.maybeDump<PropsT, ReturnT>(prompt, props);

	// first render
	let promptElement = prompt(realProps);
	if (promptElement instanceof Promise) {
		promptElement = await promptElement;
	}
	if (loggingOptions?.promptElementRef !== undefined) {
		loggingOptions.promptElementRef.current = promptElement;
	}
	let rendered: RenderOutput;
	if (renderOptions.countTokensFast_UNSAFE === "try_retry") {
		try {
			rendered = await render(promptElement, { ...renderOptions, countTokensFast_UNSAFE: true });
		} catch (e) {
			if (e instanceof TooManyTokensForBasePriority) {
				rendered = await render(promptElement, { ...renderOptions, countTokensFast_UNSAFE: false });
			} else {
				throw e
			}
		}
	} else {
		const countTokensFast = renderOptions.countTokensFast_UNSAFE === "yes";
		rendered = await render(promptElement, { ...renderOptions, countTokensFast_UNSAFE: countTokensFast });
	}
	if (loggingOptions?.renderOutputRef !== undefined) {
		loggingOptions.renderOutputRef.current = rendered;
	}


	const modelRequest = promptToOpenAIChatRequest(rendered.prompt);
	renderedMessagesCallback(modelRequest.messages);

	// now do the model call
	const modelOutput = await modelCall(modelRequest);


	// call all of them and wait all of them in parallel
	if (modelOutput.type === "output") {

		if (modelOutput.value.choices.length === 0) {
			throw new Error(`model returned no choices`);
		}

		const modelOutputMessage = modelOutput.value.choices[0].message;

		if (modelOutputMessage === undefined) {
			throw new Error(`model returned no message`);
		}

		await Promise.all(
			rendered.outputHandlers.map((handler) => handler(modelOutputMessage))
		);
	} else if (modelOutput.type === "stream") {
		// If no stream handlers, the default is to just return the first output
		if (rendered.streamHandlers.length === 0) {
			const awaitable = async function* (): AsyncIterable<ChatCompletionResponseMessage> {
				for await (const message of modelOutput.value) {
					yield message
				}
			}
			await outputCatcher.onOutput(awaitable() as ReturnT);
		} else {
			if (rendered.streamHandlers.length > 1) {
				// warn ppl
				console.warn('Multiple stream handlers received, this may cause unexpected behavior')
			}
			await Promise.all(
				rendered.streamHandlers.map((handler) => handler(modelOutput.value))
			);

		}
	} else {
		// If no stream handlers, the default is to just return the first output
		if (rendered.streamResponseObjectHandlers.length === 0) {
			const awaitable = async function* (): AsyncIterable<StreamChatCompletionResponse> {
				for await (const message of modelOutput.value) {
					yield message
				}
			}
			await outputCatcher.onOutput(awaitable() as ReturnT);
		} else {
			await Promise.all(
				rendered.streamResponseObjectHandlers.map((handler) => handler(modelOutput.value))
			);

		}
	}

	// now return the first output
	const firstOutput = outputCatcher.getOutput();

	if (firstOutput === undefined) {
		// bad bad! let's throw an error
		throw new Error(
			`No output was captured. Did you forget to include a <capture> element?`
		);
	} else {
		return firstOutput;
	}
}

// a fast, synchronous, somewhat inexact and incomplete way to render a prompt
// yields ~50x speedup in many cases and is useful for datajobs
export function renderCumulativeSum(
	elem: PromptElement,
	{ tokenLimit, tokenizer, lastMessageIsIncomplete }: RenderOptions
): Omit<RenderOutput, "tokenCount"> {
	let startTime: number | undefined;
	if (shouldPrintVerboseLogs()) {
		startTime = performance.now();
	}

	// set the tokenLimit to the max number of tokens per model
	if (tokenizer === undefined) {
		throw new Error("Must specify tokenizer or model!");
	}
	const definedTokenizer = tokenizer;

	let startTimeValidating: number | undefined;
	if (shouldPrintVerboseLogs()) {
		startTimeValidating = performance.now();
	}
	validateUnrenderedPrompt(elem);
	// Cumulative sum cannot uses firsts

	validateNoUnhandledTypes(elem)
	if (shouldPrintVerboseLogs()) {
		const endTimeValidating = performance.now();
		console.debug(`Validating prompt took ${endTimeValidating - (startTimeValidating ?? 0)} ms`);
	}

	let startTimeComputingPriorityLevels = undefined;
	startTimeComputingPriorityLevels = performance.now();

	// We normalize the node first
	const normalizedNode = normalizePrompt(elem);
	// for now, we do a much simple thing, which is just to render the whole thing every time
	const priorityLevelsTokensMapping: Record<number, Countables[]> = {};
	computePriorityLevelsTokensMapping(normalizedNode, BASE_PRIORITY, priorityLevelsTokensMapping);

	// We also just compute the priority levels the normal way for rendering later
	const priorityLevels = new Set<number>();
	computePriorityLevels(elem, BASE_PRIORITY, priorityLevels);

	// convert to array and sort them from highest to lowest
	const priorityLevelKeys = Object.keys(priorityLevelsTokensMapping).map((x) => parseInt(x));
	const sortedPriorityLevels = priorityLevelKeys.sort((a, b) => b - a);
	if (shouldPrintVerboseLogs()) {
		const endTimeComputingPriorityLevels = performance.now();
		console.debug(`Computing priority levels took ${endTimeComputingPriorityLevels - (startTimeComputingPriorityLevels ?? 0)} ms`);
	}

	// Then, we traverse in reverse order
	let runningTokenSum = 0;
	let bestTokenLevel = BASE_PRIORITY;
	for (const priorityLevel of sortedPriorityLevels) {
		const newCountables = priorityLevelsTokensMapping[priorityLevel];
		let newTokens = 0;
		newCountables.forEach((countable) => {
			if (typeof countable === 'number') {
				newTokens += countable;
			} else if (typeof countable === 'string') {
				newTokens += tokenizer.estimateNumTokensFast_SYNCHRONOUS_BE_CAREFUL(countable);
			} else if (countable.type === 'functionDefinition') {
				newTokens += countFunctionTokensApprox_SYNCHRONOUS_BE_CAREFUL(countable, definedTokenizer);
			} else if (countable.type === 'toolDefinition') {
				newTokens += countToolTokensApprox_SYNCHRONOUS_BE_CAREFUL(countable.tool, definedTokenizer);
			}
		});
		runningTokenSum += newTokens;
		if (runningTokenSum > tokenLimit) {
			break;
		}
		bestTokenLevel = priorityLevel;
	}


	let startExactTokenCount = undefined;
	if (shouldPrintVerboseLogs()) {
		startExactTokenCount = performance.now();
	}

	const prompt = renderWithLevel(elem, bestTokenLevel, tokenizer, true);

	if (prompt.prompt === undefined) {
		throw new Error(`renderWithLevel returned undefined`);
	}
	// const tokenCount = await countTokensExact(tokenizer, prompt.prompt ?? "", { lastMessageIsIncomplete });

	// if (tokenCount + prompt.emptyTokenCount > tokenLimit) {
	// this means that the base level prompt is too big
	// we could either return an empty string or we could throw an error here
	// this is never desirable behavior, and indicates a bug with the prompt
	// hence we throw an error
	// throw new Error(`Base prompt estimated token count is ${tokenCount} with ${prompt.emptyTokenCount} tokens reserved, which is higher than the limit ${tokenLimit}. This is probably a bug in the prompt — please add some priority levels to fix this.`);
	// }

	if (shouldPrintVerboseLogs()) {
		const endExactTokenCount = performance.now();
		console.debug(`Computing exact token count took ${endExactTokenCount - (startExactTokenCount ?? 0)} ms`);
	}

	let duration: number | undefined = undefined;
	if (startTime !== undefined) {
		const endTime = performance.now();
		duration = endTime - startTime;
		if (duration > 100) {
			console.warn(`Priompt WARNING: rendering prompt took ${duration} ms, which is longer than the recommended maximum of 100 ms. Consider reducing the number of scopes you have.`)
		}
	}
	return {
		prompt: prompt.prompt,
		// tokenCount: 0,
		tokensReserved: prompt.emptyTokenCount,
		tokenLimit: tokenLimit,
		tokenizer,
		durationMs: duration,
		outputHandlers: prompt.outputHandlers,
		streamHandlers: prompt.streamHandlers,
		streamResponseObjectHandlers: prompt.streamResponseObjectHandlers,
		priorityCutoff: bestTokenLevel,
		config: prompt.config,
	};

}


export async function renderBinarySearch(
	elem: PromptElement,
	{ tokenLimit, tokenizer, lastMessageIsIncomplete, countTokensFast_UNSAFE, shouldBuildSourceMap }: RenderOptions,
): Promise<RenderOutput> {
	const startTime = performance.now();
	validateUnrenderedPrompt(elem);
	const validatingDuration = performance.now() - startTime;
	statsd.distribution('priompt.validateUnrenderedPrompt', validatingDuration);
	if (shouldPrintVerboseLogs()) {
		console.debug(`Validating prompt took ${validatingDuration} ms`);
	}

	// Try to output the prompt element node count for performance debugging
	try {
		statsd.distribution('priompt.promptElementNodeCount', getPromptElementNodeCount(elem));
	} catch {
		// ignore
	}

	const startTimeComputingPriorityLevels = performance.now();
	// for now, we do a much simple thing, which is just to render the whole thing every time
	const priorityLevels = new Set<number>();
	computePriorityLevels(elem, BASE_PRIORITY, priorityLevels);
	priorityLevels.add(BASE_PRIORITY);
	// convert to array and sort them from lowest to highest
	const sortedPriorityLevels = Array.from(priorityLevels).sort((a, b) => a - b);
	const computingPriorityLevelsDuration = performance.now() - startTimeComputingPriorityLevels;
	const bucketedLength = Math.pow(2, Math.floor(Math.log2(sortedPriorityLevels.length + 1)));
	statsd.distribution('priompt.computePriorityLevels', computingPriorityLevelsDuration, {
		'bucketedLength': bucketedLength.toString()
	});
	if (shouldPrintVerboseLogs()) {
		console.debug(`Computing priority levels took ${computingPriorityLevelsDuration} ms`);
	}

	// We lower the token limit if this is an approx count
	let usedTokenlimit: number;
	if (countTokensFast_UNSAFE === true) {
		usedTokenlimit = tokenLimit * 0.95
	} else {
		usedTokenlimit = tokenLimit;
	}

	// now we hydrate the isolates
	const startTimeHydratingIsolates = performance.now();
	await hydrateIsolates(elem, tokenizer, shouldBuildSourceMap);
	const hydrateIsolatesDuration = performance.now() - startTimeHydratingIsolates;
	statsd.distribution('priompt.hydrateIsolates', hydrateIsolatesDuration, {
		'bucketedLength': bucketedLength.toString()
	});
	if (shouldPrintVerboseLogs()) {
		console.debug(`Hydrating isolates took ${hydrateIsolatesDuration} ms`);
	}

	await hydrateEmptyTokenCount(elem, tokenizer);

	const startTimeRendering = performance.now();

	// the lowest priority level is as far as the cutoff can go
	// we choose an exclusive lower bound and an inclusive upper bound because we get the information
	// if TOKEN LIMIT OK: then the answer has to be <= to the candidate
	// if TOKEN LIMIT NOT OK: then the answer has to be > than the candidate
	let largestTokenCountSeen = 0;
	let exclusiveLowerBound = -1;
	let inclusiveUpperBound = sortedPriorityLevels.length - 1;

	while (exclusiveLowerBound < inclusiveUpperBound - 1) {
		const candidateLevelIndex = Math.floor((exclusiveLowerBound + inclusiveUpperBound) / 2);
		const candidateLevel = sortedPriorityLevels[candidateLevelIndex];
		let start: number | undefined;
		if (shouldPrintVerboseLogs()) {
			console.debug(`Trying candidate level ${candidateLevel} with index ${candidateLevelIndex}`)
			start = performance.now();
		}
		let countStart: number | undefined;
		let tokenCount = -1;
		try {
			const prompt = renderWithLevelAndEarlyExitWithTokenEstimation(elem, candidateLevel, tokenizer, tokenLimit);
			countStart = performance.now();
			// const prompt = renderWithLevel(elem, candidateLevel);
			if (countTokensFast_UNSAFE === true) {
				tokenCount = await countTokensApproxFast_UNSAFE(tokenizer, prompt.prompt ?? "", { lastMessageIsIncomplete });
			} else {
				tokenCount = await countTokensExact(tokenizer, prompt.prompt ?? "", { lastMessageIsIncomplete });
			}
			largestTokenCountSeen = Math.max(largestTokenCountSeen, tokenCount);
			if (tokenCount + prompt.emptyTokenCount > usedTokenlimit) {
				// this means that the candidateLevel is too low
				exclusiveLowerBound = candidateLevelIndex;
			} else {
				// this means the candidate level is too high or it is just right
				inclusiveUpperBound = candidateLevelIndex;
			}
		} catch {
			// this means the candidate level is too low
			exclusiveLowerBound = candidateLevelIndex;
		} finally {
			if (shouldPrintVerboseLogs()) {
				const end = performance.now();
				console.debug(`Candidate level ${candidateLevel} with index ${candidateLevelIndex} took ${end - (start ?? 0)} ms and has ${tokenCount} tokens(-1 means early exit, counting took ${end - (countStart ?? 0)})`);
			}
		}
	}
	statsd.distribution('priompt.largestTokenCountSeen', largestTokenCountSeen, {
		'bucketedLength': bucketedLength.toString()
	});

	const renderingDuration = performance.now() - startTimeRendering;
	statsd.distribution('priompt.rendering', renderingDuration, {
		'bucketedLength': bucketedLength.toString()
	});

	if (shouldPrintVerboseLogs()) {
		console.debug(`Rendering prompt took ${renderingDuration} ms spl = ${sortedPriorityLevels.length} `);
	}

	const renderWithLevelStartTime = performance.now();
	const prompt = renderWithLevel(elem, sortedPriorityLevels[inclusiveUpperBound], tokenizer, true, shouldBuildSourceMap === true ? {
		name: 'root',
		isLast: undefined,
	} : undefined);
	const renderWithLevelDuration = performance.now() - renderWithLevelStartTime;
	statsd.distribution('priompt.renderWithLevel', renderWithLevelDuration, {
		'bucketedLength': bucketedLength.toString()
	});

	if (prompt.sourceMap !== undefined) {
		const normalizeSourceMapStartTime = performance.now();
		prompt.sourceMap = normalizeSourceMap(prompt.sourceMap);
		const normalizeSourceMapDuration = performance.now() - normalizeSourceMapStartTime;
		statsd.distribution('priompt.normalizeSourceMap', normalizeSourceMapDuration, {
			'bucketedLength': bucketedLength.toString()
		});
	}

	const startExactTokenCount = performance.now();
	const tokenCount = await countTokensExact(tokenizer, prompt.prompt ?? "", { lastMessageIsIncomplete });
	const exactTokenCountDuration = performance.now() - startExactTokenCount;
	statsd.distribution('priompt.countTokensExact', exactTokenCountDuration, {
		'bucketedLength': bucketedLength.toString()
	});
	statsd.distribution('priompt.countTokensExactTokenCount', tokenCount, {
		'bucketedLength': bucketedLength.toString()
	});
	if (shouldPrintVerboseLogs()) {
		console.debug(`Computing exact token count took ${exactTokenCountDuration} ms`);
	}

	if (tokenCount + prompt.emptyTokenCount > tokenLimit) {
		// this means that the base level prompt is too big
		// we could either return an empty string or we could throw an error here
		// this is never desirable behavior, and indicates a bug with the prompt
		// hence we throw an error
		throw new TooManyTokensForBasePriority(`Base prompt estimated token count is ${tokenCount} with ${prompt.emptyTokenCount} tokens reserved, which is higher than the limit ${tokenLimit}. This is probably a bug in the prompt — please add some priority levels to fix this.`);
	}

	const renderBinarySearchDuration = performance.now() - startTime;
	statsd.distribution('priompt.renderBinarySearch', renderBinarySearchDuration, {
		'bucketedLength': bucketedLength.toString()
	});
	if (shouldPrintVerboseLogs() && renderBinarySearchDuration > 100) {
		console.warn(`Priompt WARNING: rendering prompt took ${renderBinarySearchDuration} ms, which is longer than the recommended maximum of 100 ms.Consider reducing the number of scopes you have.`)
	}
	return {
		prompt: prompt.prompt ?? "",
		tokenCount: tokenCount,
		tokensReserved: prompt.emptyTokenCount,
		tokenLimit: tokenLimit,
		tokenizer,
		durationMs: renderBinarySearchDuration,
		outputHandlers: prompt.outputHandlers,
		streamHandlers: prompt.streamHandlers,
		streamResponseObjectHandlers: prompt.streamResponseObjectHandlers,
		priorityCutoff: sortedPriorityLevels[inclusiveUpperBound],
		sourceMap: prompt.sourceMap,
		config: prompt.config,
	};

}

export async function renderBackwardsLinearSearch(elem: PromptElement, { tokenLimit, tokenizer, lastMessageIsIncomplete }: RenderOptions): Promise<RenderOutput> {
	let startTime: number | undefined;
	if (shouldPrintVerboseLogs()) {
		startTime = performance.now();
	}

	let startTimeValidating: number | undefined;
	if (shouldPrintVerboseLogs()) {
		startTimeValidating = performance.now();
		// only validate in debug
		validateUnrenderedPrompt(elem);
		const endTimeValidating = performance.now();
		console.debug(`Validating prompt took ${endTimeValidating - (startTimeValidating ?? 0)} ms`);
	}


	// ALGORITHM:
	// 1. Build a sorted list of all priorities.
	// 2. Compute an estimated lower/upper bound on the level using the number of bytes + a linear scan.
	// 3. For each block present in the lower level, compute the real token count.
	// 4. Now do a linear scan in priority level until the real token count is at or below the limit + create an upper bound where the sum of the tokens are #nodes more than the limit.
	// 5. Finally, do binary search on the updated lower/upper bound where we tokenize the full prompt every time.
	// TODO: actually implement this, instead of doing the super naive version we are doing right now


	// actually..... we do an additive approach instead. this has slightly different semantics for the <first> tag, but it is very simple and easy to reason about
	// so we go from the highest possible priority, adding in things at each time

	// FOR NOW: we do an additive search from highest cutoff to lowest, caching the token count of each element (where an element is a scope — strings themselves will be merged first, because we want as big chunks as possible to feed into tiktoken for both efficiency and accuracy reasons)
	// TODO: come up with a better algorithm here. this one is fine for now. just doesn't work if someone creates really low-character scopes but why would they

	let startTimeNormalizing = undefined;
	if (shouldPrintVerboseLogs()) {
		startTimeNormalizing = performance.now();
	}
	const normalizedElem = normalizePrompt(elem);
	if (shouldPrintVerboseLogs()) {
		const endTimeNormalizing = performance.now();
		console.debug(`Normalizing prompt took ${endTimeNormalizing - (startTimeNormalizing ?? 0)} ms`);
	}

	console.debug(normalizedElem, "normalizedElem");


	let startTimeComputingPriorityLevels = undefined;
	if (shouldPrintVerboseLogs()) {
		startTimeComputingPriorityLevels = performance.now();
	}
	// for now, we do a much simple thing, which is just to render the whole thing every time
	const priorityLevels = new Set<number>();
	computePriorityLevels(normalizedElem, BASE_PRIORITY, priorityLevels);
	priorityLevels.add(BASE_PRIORITY);
	// convert to array and sort them from highest to lowest
	const sortedPriorityLevels = Array.from(priorityLevels).sort((a, b) => b - a);
	if (shouldPrintVerboseLogs()) {
		const endTimeComputingPriorityLevels = performance.now();
		console.debug(`Computing priority levels took ${endTimeComputingPriorityLevels - (startTimeComputingPriorityLevels ?? 0)} ms`);
	}

	// if the first one is higher than the base priority, then print a warning because it will not have any effect

	let startTimeRendering = undefined;
	if (shouldPrintVerboseLogs()) {
		startTimeRendering = performance.now();
	}

	// naive version: just render the whole thing for every priority level, and pick the first one that is below the limit
	let prevPrompt: RenderWithLevelPartialTypeWithCount | undefined = undefined;
	let prevLevel: number | undefined = undefined;
	let thisPrompt: RenderWithLevelPartialTypeWithCount | undefined = undefined;
	for (const level of sortedPriorityLevels) {
		thisPrompt = await renderWithLevelAndCountTokens(normalizedElem, level, tokenizer);
		if (isChatPrompt(thisPrompt.prompt)) {
			thisPrompt.tokenCount += CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT;
		}
		if (thisPrompt.tokenCount + thisPrompt.emptyTokenCount > tokenLimit) {
			break;
		}
		prevPrompt = thisPrompt;
		prevLevel = level;
	}

	if (shouldPrintVerboseLogs()) {
		const endTimeRendering = performance.now();
		console.debug(`Rendering prompt took ${endTimeRendering - (startTimeRendering ?? 0)} ms`);
	}

	if (prevPrompt === undefined) {
		// this means that the base level prompt is too big
		// we could either return an empty string or we could throw an error here
		// this is never desirable behavior, and indicates a bug with the prompt
		// hence we throw an error
		throw new TooManyTokensForBasePriority(`Base prompt estimated token count is ${thisPrompt?.tokenCount} with ${thisPrompt?.emptyTokenCount} tokens reserved, which is higher than the limit ${tokenLimit}. This is probably a bug in the prompt — please add some priority levels to fix this.`);
	}

	let startExactTokenCount = undefined;
	if (shouldPrintVerboseLogs()) {
		startExactTokenCount = performance.now();
	}

	// now get the *actual* token count
	// the reason this might be different is tokens that span scopes
	// we do this because maybe sometimes you want the actually correct token count?
	// this token count should be smaller than the estimated token count (since now boundaries are allowed), but there might be an edge case where this actually yields a larger token count
	// in that case, it is normally fine to just have the token count be slightly too big to fit
	// because you always have a gap to fill anyways
	// consider adding a mode that if this happens, backtracks
	if (prevPrompt.prompt !== undefined) {
		const exactTokenCount = await countTokensExact(tokenizer, prevPrompt.prompt, { lastMessageIsIncomplete });
		console.debug(`Discrepancy: (estimated token count) - (actual token count) = ${prevPrompt.tokenCount} - ${exactTokenCount} = ${prevPrompt.tokenCount - exactTokenCount} `);
		prevPrompt.tokenCount = exactTokenCount;
		if (exactTokenCount + prevPrompt.emptyTokenCount > tokenLimit) {
			console.warn(`Actual token count is ${exactTokenCount} with ${prevPrompt.emptyTokenCount} tokens reserved, which is higher than the limit ${tokenLimit}. This can possibly happen in rare circumstances, but should never be a problem in practice.`)
		}
	}

	if (shouldPrintVerboseLogs()) {
		const endExactTokenCount = performance.now();
		console.debug(`Computing exact token count took ${endExactTokenCount - (startExactTokenCount ?? 0)} ms`);
	}

	let duration: number | undefined = undefined;
	if (startTime !== undefined) {
		const endTime = performance.now();
		duration = endTime - startTime;
	}
	return {
		prompt: prevPrompt.prompt ?? "",
		tokenCount: prevPrompt.tokenCount,
		tokensReserved: prevPrompt.emptyTokenCount,
		tokenLimit: tokenLimit,
		tokenizer,
		outputHandlers: prevPrompt.outputHandlers,
		streamHandlers: prevPrompt.streamHandlers,
		streamResponseObjectHandlers: prevPrompt.streamResponseObjectHandlers,
		durationMs: duration,
		priorityCutoff: prevLevel ?? BASE_PRIORITY,
		config: prevPrompt.config,
	};

}

type NormalizedString = {
	type: 'normalizedString';
	s: string;
	cachedCount: number | undefined;
}
type NormalizedScope = Omit<Scope, 'children'> & {
	children: NormalizedNode[];
};
type NormalizedFirst = Omit<First, 'children'> & {
	children: NormalizedScope[];
};
type NormalizedChatUserSystemMessage = Omit<ChatUserSystemMessage, 'children'> & {
	children: NormalizedNode[];
};
type NormalizedChatAssistantMessage = Omit<ChatAssistantMessage, 'children'> & {
	children: NormalizedNode[];
};
type NormalizedChatFunctionResultMessage = Omit<ChatFunctionResultMessage, 'children'> & {
	children: NormalizedNode[];
};
type NormalizedChatToolResultMessage = Omit<ChatToolResultMessage, 'children'> & {
	children: NormalizedNode[];
};
type NormalizedChatMessage = NormalizedChatUserSystemMessage | NormalizedChatAssistantMessage | NormalizedChatFunctionResultMessage | NormalizedChatToolResultMessage;
type NormalizedFunctionDefinition = FunctionDefinition & {
	cachedCount: number | undefined;
}
type NormalizedToolDefinition = ToolDefinition & {
	cachedCount: number | undefined;
}
type NormalizedNode = NormalizedFirst | NormalizedScope | BreakToken | Config | Empty | Isolate | Capture | NormalizedChatMessage | NormalizedString | ChatImage | NormalizedFunctionDefinition | NormalizedToolDefinition;
type NormalizedPromptElement = NormalizedNode[];
function normalizePrompt(elem: PromptElement): NormalizedPromptElement {
	// we want to merge all the strings together
	const result: NormalizedNode[] = [];
	let currentString = "";
	const elemArray = Array.isArray(elem) ? elem : [elem];
	const pushCurrentString = () => {
		if (currentString.length > 0) {
			result.push({
				type: 'normalizedString',
				s: currentString,
				cachedCount: undefined
			});
			currentString = "";
		}
	}
	for (const node of elemArray) {
		if (node === undefined || node === null) {
			continue;
		}
		if (typeof node === 'string') {
			currentString += node;
		} else if (typeof node === 'number') {
			currentString += node.toString();
		} else if (typeof node === 'object') {
			pushCurrentString();
			let newNode: NormalizedNode;
			switch (node.type) {
				case 'config':
				case 'capture':
				case 'isolate':
				case 'breaktoken':
				case 'image':
				case 'empty': {
					newNode = node;
					break;
				}
				case 'toolDefinition':
				case 'functionDefinition': {
					newNode = {
						...node,
						cachedCount: undefined
					};
					break;
				}
				case 'first': {
					newNode = {
						...node,
						children: node.children.map(c => {
							return {
								...c,
								children: normalizePrompt(c.children)
							};
						}
						),
					};
					break;
				}
				case 'chat':
				case 'scope': {
					newNode = {
						...node,
						children: normalizePrompt(node.children)
					};
					break;
				}
			}
			result.push(newNode);
		} else {
			throw new Error("Invalid prompt element");
		}
	}
	pushCurrentString();
	return result;
}

type RenderWithLevelPartialType = {
	prompt: RenderedPrompt | undefined;
	emptyTokenCount: number;
	outputHandlers: OutputHandler<ChatCompletionResponseMessage>[];
	streamHandlers: OutputHandler<AsyncIterable<ChatCompletionResponseMessage>>[];
	streamResponseObjectHandlers: OutputHandler<AsyncIterable<StreamChatCompletionResponse>>[];
	config: ConfigProps;
	sourceMap?: SourceMap;
};
type RenderWithLevelPartialTypeWithCount = RenderWithLevelPartialType & { tokenCount: number; };

// if chat prompt, the token count will be missing the constant factor
async function renderWithLevelAndCountTokens(elem: NormalizedNode[] | NormalizedNode, level: number, tokenizer: PriomptTokenizer): Promise<RenderWithLevelPartialTypeWithCount> {
	if (Array.isArray(elem)) {
		return (await Promise.all(elem.map(e => renderWithLevelAndCountTokens(e, level, tokenizer)))).reduce((a, b) => {
			// Safe to mutate in place because the reduction starts with a new empty object
			a.prompt = sumPrompts(a.prompt, b.prompt);
			a.tokenCount += b.tokenCount;
			a.emptyTokenCount += b.emptyTokenCount;
			b.outputHandlers.forEach(handler => a.outputHandlers.push(handler));
			b.streamHandlers.forEach(handler => a.streamHandlers.push(handler));
			b.streamResponseObjectHandlers.forEach(handler => a.streamResponseObjectHandlers.push(handler));
			a.config = mergeConfigsInPlace(a.config, b.config);
			return a;
		}, {
			prompt: undefined,
			tokenCount: 0,
			emptyTokenCount: 0,
			outputHandlers: [],
			streamHandlers: [],
			streamResponseObjectHandlers: [],
			config: {
				maxResponseTokens: undefined,
				stop: undefined,
			},
		});
	}
	switch (elem.type) {
		case 'first': {
			for (const child of elem.children) {
				if (child.absolutePriority === undefined) {
					throw new Error(`BUG!! computePriorityLevels should have set absolutePriority for all children of first`);
				}
				if (child.absolutePriority >= level) {
					return renderWithLevelAndCountTokens(child, level, tokenizer);
				}
			}
			// nothing returned from first, which is ok
			return {
				prompt: undefined,
				tokenCount: 0,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			};
		}
		case 'image': {
			const base64EncodedBytes = Buffer.from(elem.bytes).toString('base64');
			const mediaType = getImageMimeType(elem.bytes);
			return {
				prompt: {
					type: 'prompt_content',
					content: [],
					images: [{
						type: 'image_url',
						image_url: {
							url: `data:${mediaType}; base64, ${base64EncodedBytes} `,
							detail: elem.detail,
							// Temporary addition to be removed before sent to openai
							dimensions: elem.dimensions,
						}
					}],
				},
				// Count the number of tokens for the image
				emptyTokenCount: 0,
				tokenCount: numTokensForImage(elem.dimensions, elem.detail),
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'capture': {
			return {
				prompt: undefined,
				tokenCount: 0,
				emptyTokenCount: 0,
				outputHandlers: elem.onOutput !== undefined ? [elem.onOutput] : [],
				streamHandlers: elem.onStream !== undefined ? [elem.onStream] : [],
				streamResponseObjectHandlers: elem.onStreamResponseObject !== undefined ? [elem.onStreamResponseObject] : [],
				config: emptyConfig(),
			}
		}
		case 'config': {
			return {
				prompt: undefined,
				tokenCount: 0,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: elem
			}
		}
		case 'breaktoken': {
			return {
				// a breaktoken is just a split!
				prompt: ['', ''],
				tokenCount: 0,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'empty': {
			if (elem.tokenCount === undefined) {
				if (elem.tokenFunction === undefined) {
					throw new Error(`BUG!! empty token function is undefined.THIS SHOULD NEVER HAPPEN.BUG IN PRIOMPT.`);
				}
				elem.tokenCount = await elem.tokenFunction((s) => tokenizer.numTokens(s));
			}
			return {
				prompt: undefined,
				tokenCount: 0,
				emptyTokenCount: elem.tokenCount,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'functionDefinition': {
			if (elem.cachedCount === undefined) {
				elem.cachedCount = await countFunctionTokens(elem, tokenizer);
			}
			const prompt: (TextPrompt & FunctionPrompt) = {
				type: 'text',
				text: "",
				functions: [
					{
						name: elem.name,
						description: elem.description,
						parameters: elem.parameters,
					}
				]
			};
			return {
				prompt,
				tokenCount: elem.cachedCount,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'toolDefinition': {
			if (elem.cachedCount === undefined) {
				elem.cachedCount = await countToolTokens(elem.tool, tokenizer);
			}
			const prompt: (TextPrompt & ToolPrompt) = {
				type: 'text',
				text: "",
				tools: [
					{
						type: 'function',
						function: {
							name: elem.tool.function.name,
							description: elem.tool.function.description,
							parameters: elem.tool.function.parameters,
						}
					}
				]
			};
			return {
				prompt,
				tokenCount: elem.cachedCount,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'isolate': {
			// check if we have a cached prompt
			if (elem.cachedRenderOutput === undefined) {
				elem.cachedRenderOutput = await render(elem.children, {
					tokenizer,
					tokenLimit: elem.tokenLimit,
				})
			}
			return {
				prompt: elem.cachedRenderOutput.prompt,
				tokenCount: elem.cachedRenderOutput.tokenCount,
				emptyTokenCount: elem.cachedRenderOutput.tokensReserved,
				outputHandlers: elem.cachedRenderOutput.outputHandlers,
				streamHandlers: elem.cachedRenderOutput.streamHandlers,
				streamResponseObjectHandlers: elem.cachedRenderOutput.streamResponseObjectHandlers,
				config: emptyConfig(),
			}
		}
		case 'chat': {
			const p = await renderWithLevelAndCountTokens(elem.children, level, tokenizer);
			if (isChatPrompt(p.prompt)) {
				throw new Error(`Incorrect prompt: we have nested chat messages, which is not allowed!`);
			}

			let extraTokenCount = 0;
			let message: ChatPromptMessage;
			if (elem.role === 'user') {
				if (isPromptContent(p.prompt)) {
					message = {
						role: elem.role,
						name: elem.name,
						to: elem.to,
						content: p.prompt.content,
						images: p.prompt.images,
					};
				} else {
					message = {
						role: elem.role,
						name: elem.name,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					};
				}
			} else if (elem.role === 'system') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in system message')
				} else {
					message = {
						role: elem.role,
						name: elem.name,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					};
				}
			} else if (elem.role === 'assistant') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in assistant message')
				}
				if (elem.functionCall !== undefined) {
					message = {
						role: elem.role,
						// intentionally can be undefined because an assistant message can, for example, contain only a function call
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text),
						to: elem.to,
						functionCall: elem.functionCall,
					}
					extraTokenCount += await countFunctionCallMessageTokens(elem.functionCall, tokenizer);
				} else if (elem.toolCalls !== undefined && elem.toolCalls.length > 0) {
					message = {
						role: elem.role,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
						toolCalls: elem.toolCalls,
					}
				} else {
					message = {
						role: elem.role,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					}
				}
			} else if (elem.role === 'function') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in function message')
				}
				message = {
					role: elem.role,
					name: elem.name,
					to: elem.to,
					content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
				}
				extraTokenCount += await tokenizer.numTokens(elem.name);
			} else if (elem.role === 'tool') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in tool message')
				}
				message = {
					role: elem.role,
					name: elem.name,
					to: elem.to,
					content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
				}
				extraTokenCount += await tokenizer.numTokens(elem.name);
			} else {
				const x: never = elem.role;
				throw new Error(`BUG!! Invalid role ${elem.role} `);
			}

			return {
				prompt: {
					type: 'chat',
					messages: [message],
					functions: promptHasFunctions(p.prompt) ? p.prompt.functions : undefined,
					tools: promptHasTools(p.prompt) ? p.prompt.tools : undefined,
				},
				tokenCount: p.tokenCount + CHATML_PROMPT_EXTRA_TOKEN_COUNT_LINEAR_FACTOR + extraTokenCount,
				emptyTokenCount: p.emptyTokenCount,
				outputHandlers: p.outputHandlers,
				streamHandlers: p.streamHandlers,
				streamResponseObjectHandlers: p.streamResponseObjectHandlers,
				config: emptyConfig(),
			}
		}
		case 'scope': {
			if (elem.absolutePriority === undefined) {
				throw new Error(`BUG!! computePriorityLevels should have set absolutePriority for all scopes`);
			}
			if (elem.absolutePriority >= level) {
				return renderWithLevelAndCountTokens(elem.children, level, tokenizer);
			}
			return {
				prompt: undefined,
				tokenCount: 0,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'normalizedString': {
			if (elem.cachedCount === undefined) {
				elem.cachedCount = await tokenizer.numTokens(elem.s);
			}
			return {
				prompt: elem.s,
				tokenCount: elem.cachedCount,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			};
		}
	}
}

// WARNING: do not attempt to make this function async!!! it will make it a lot slower!
function renderWithLevelAndEarlyExitWithTokenEstimation(elem: PromptElement, level: number, tokenizer: PriomptTokenizer, tokenLimit: number): {
	prompt: RenderedPrompt | undefined;
	emptyTokenCount: number;
} {

	// High level, rather than constructing a new object at each recursive call, we'll just accumulate the result into
	// these variables. This saves on a massive amount of allocations for large prompt trees and significantly improves
	// performance (around 10x for this function based on benchmarks).
	let prompt: RenderedPrompt | undefined = undefined;
	let emptyTokenCount = 0;

	function renderInPlace(elem: PromptElement) {
		if (elem === undefined || elem === null || elem === false) {
			return;
		}
		if (Array.isArray(elem)) {
			elem.forEach(e => renderInPlace(e));
			const lowerBound = estimateLowerBoundTokensForPrompt(prompt, tokenizer);
			if (lowerBound > tokenLimit) {
				throw new Error(`Token limit exceeded!`);
			}
			return;
		}
		if (typeof elem === 'string') {
			prompt = (sumPrompts(prompt, elem));
			return;
		}
		if (typeof elem === 'number') {
			prompt = sumPrompts(prompt, elem.toString());
			return;
		}
		switch (elem.type) {
			case 'first': {
				for (const child of elem.children) {
					if (child.absolutePriority === undefined) {
						throw new Error(`BUG!! computePriorityLevels should have set absolutePriority for all children of first`);
					}
					if (child.absolutePriority >= level) {
						renderInPlace(child);
						return;
					}
				}
				// nothing rendered for first, which is ok
				return;
			}
			case 'capture':
			case 'config': {
				// we're not rendering the config or capture here
				return;
			}
			case 'breaktoken': {
				prompt = sumPrompts(prompt, ['', '']);
				return;
			}
			case 'empty': {
				if (elem.tokenCount === undefined) {
					throw new Error(`BUG!! empty token count is undefined.THIS SHOULD NEVER HAPPEN.BUG IN PRIOMPT.Empty token count should've been hydrated first!`);
				}
				emptyTokenCount += elem.tokenCount;
				return;
			}
			case 'functionDefinition': {
				prompt = sumPrompts(prompt, {
					type: 'text',
					text: "",
					functions: [
						{
							name: elem.name,
							description: elem.description,
							parameters: elem.parameters,
						}
					]
				});
				return;
			}
			case 'toolDefinition': {
				prompt = sumPrompts(prompt, {
					type: 'text',
					text: "",
					tools: [
						{
							type: 'function',
							function: {
								name: elem.tool.function.name,
								description: elem.tool.function.description,
								parameters: elem.tool.function.parameters,
							}
						}
					]
				});
				return;
			}
			case 'image': {
				const base64EncodedBytes = Buffer.from(elem.bytes).toString('base64');
				const mediaType = getImageMimeType(elem.bytes);
				prompt = sumPrompts(prompt, {
					type: 'prompt_content',
					content: [],
					images: [{
						type: 'image_url',
						image_url: {
							url: `data:${mediaType};base64,${base64EncodedBytes}`,
							detail: elem.detail,
							dimensions: elem.dimensions,
						}
					}],
				});
				return;
			}
			case 'isolate': {
				// check if we have a cached prompt
				if (elem.cachedRenderOutput === undefined) {
					// throw error! we need to hydrate the isolates first!
					throw new Error(`BUG!! Isolates should have been hydrated before calling renderWithLevelAndEarlyExitWithTokenEstimation`);
				}
				prompt = sumPrompts(prompt, elem.cachedRenderOutput.prompt);
				emptyTokenCount += elem.cachedRenderOutput.tokensReserved;
				return;
			}
			case 'scope': {
				if (elem.absolutePriority === undefined) {
					throw new Error(`BUG!! computePriorityLevels should have set absolutePriority for all scopes`);
				}
				if (elem.absolutePriority >= level) {
					renderInPlace(elem.children);
				}
				return;
			}
			case 'chat': {
				// Chat requires special handling because we need to check if any of the children are chat messages
				// along with a lot of special logic based on the child types, so just use the outer renderWithLevel
				// rather than a renderInPlace. Chat prompts don't show up that often in the tree, so its fine to do this.
				const p = renderWithLevelAndEarlyExitWithTokenEstimation(elem.children, level, tokenizer, tokenLimit);
				if (isChatPrompt(p.prompt)) {
					throw new Error(`Incorrect prompt: we have nested chat messages, which is not allowed!`);
				}

				let message: ChatPromptMessage;
				if (elem.role === 'user') {
					if (isPromptContent(p.prompt)) {
						message = {
							role: elem.role,
							name: elem.name,
							to: elem.to,
							content: p.prompt.content,
							images: p.prompt.images,
						};
					} else {
						message = {
							role: elem.role,
							to: elem.to,
							name: elem.name,
							content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
						};
					}
				} else if (elem.role === 'system') {
					if (isPromptContent(p.prompt)) {
						throw new Error('Did not expect images in system message')
					}
					message = {
						role: elem.role,
						to: elem.to,
						name: elem.name,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					};
				} else if (elem.role === 'assistant') {
					if (isPromptContent(p.prompt)) {
						throw new Error('Did not expect images in assistant message')
					}
					if (elem.functionCall !== undefined) {
						message = {
							role: elem.role,
							to: elem.to,
							content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text),
							functionCall: elem.functionCall,
						}
					} else if (elem.toolCalls !== undefined) {
						message = {
							role: elem.role,
							to: elem.to,
							content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text),
							toolCalls: elem.toolCalls,
						}
					} else {
						message = {
							role: elem.role,
							to: elem.to,
							content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
						}
					}
				} else if (elem.role === 'function') {
					if (isPromptContent(p.prompt)) {
						throw new Error('Did not expect images in function message')
					}
					message = {
						role: elem.role,
						name: elem.name,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					}
				} else if (elem.role === 'tool') {
					if (isPromptContent(p.prompt)) {
						throw new Error('Did not expect images in tool message')
					}
					message = {
						role: elem.role,
						name: elem.name,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					}
				} else {
					const x: never = elem.role;
					throw new Error(`BUG!! Invalid role ${elem.role}`);
				}

				prompt = sumPrompts(prompt, {
					type: 'chat',
					messages: [message],
					functions: promptHasFunctions(p.prompt) ? p.prompt.functions : undefined,
					tools: promptHasTools(p.prompt) ? p.prompt.tools : undefined,
				});
				emptyTokenCount += p.emptyTokenCount;
				return;
			}
		}
	}

	renderInPlace(elem);
	return {
		prompt,
		emptyTokenCount,
	}
}

function recursivelyEject(elem: PromptElement) {
	if (elem === undefined || elem === null || elem === false || typeof elem === 'string' || typeof elem === 'number') {
		return;
	}
	if (Array.isArray(elem)) {
		elem.forEach(e => recursivelyEject(e));
	} else {
		if ('onEject' in elem && elem.onEject !== undefined && typeof elem.onEject === 'function') {
			elem.onEject();
		}
		if ('children' in elem && elem.children !== undefined && Array.isArray(elem.children)) {
			elem.children.forEach(e => recursivelyEject(e));
		}
	}
}

function hydrateEmptyTokenCount(elem: PromptElement, tokenizer: PriomptTokenizer): Promise<void> | undefined {
	if (elem === undefined || elem === null || elem === false) {
		return;
	}
	if (Array.isArray(elem)) {
		const results = elem.map(e => hydrateEmptyTokenCount(e, tokenizer));
		if (results.some(r => r !== undefined)) {
			return Promise.all(results.filter(r => r !== undefined)).then(() => { });
		} else {
			return undefined;
		}
	}
	if (typeof elem === 'string') {
		return;
	}
	if (typeof elem === 'number') {
		return;
	}
	switch (elem.type) {
		case 'chat':
		case 'scope':
		case 'first': {
			return hydrateEmptyTokenCount(elem.children, tokenizer);
		}
		case 'capture':
		case 'image':
		case 'isolate':
		case 'breaktoken':
		case 'config':
		case 'toolDefinition':
		case 'functionDefinition': {
			return;
		}
		case 'empty': {
			// check if we have a cached prompt
			if (elem.tokenCount === undefined) {
				const promise = (async () => {
					if (elem.tokenFunction === undefined) {
						throw new Error(`BUG!! empty token function is undefined. THIS SHOULD NEVER HAPPEN. BUG IN PRIOMPT.`);
					}
					elem.tokenCount = await elem.tokenFunction((s) => tokenizer.numTokens(s));
				})();
				return promise;
			}
			return;
		}
	}
}

function hydrateIsolates(elem: PromptElement, tokenizer: PriomptTokenizer, shouldBuildSourceMap: boolean | undefined): Promise<void> | undefined {
	if (elem === undefined || elem === null || elem === false) {
		return;
	}
	if (Array.isArray(elem)) {
		const results = elem.map(e => hydrateIsolates(e, tokenizer, shouldBuildSourceMap));
		if (results.some(r => r !== undefined)) {
			return Promise.all(results.filter(r => r !== undefined)).then(() => { });
		} else {
			return undefined;
		}
	}
	if (typeof elem === 'string') {
		return;
	}
	if (typeof elem === 'number') {
		return;
	}
	switch (elem.type) {
		case 'first': {
			return hydrateIsolates(elem.children, tokenizer, shouldBuildSourceMap);
		}
		case 'capture':
		case 'empty':
		case 'image':
		case 'breaktoken':
		case 'config':
		case 'functionDefinition':
		case 'toolDefinition': {
			return;
		}
		case 'isolate': {
			// check if we have a cached prompt
			if (elem.cachedRenderOutput === undefined) {
				const promise = (async () => {
					elem.cachedRenderOutput = await render(elem.children, {
						tokenizer,
						tokenLimit: elem.tokenLimit,
						shouldBuildSourceMap,
					});
				})();
				return promise;
			}
			return;
		}
		case 'chat': {
			return hydrateIsolates(elem.children, tokenizer, shouldBuildSourceMap);
		}
		case 'scope': {
			return hydrateIsolates(elem.children, tokenizer, shouldBuildSourceMap);
		}
	}
}
type SourceInfo = {
	name: string;
	isLast: boolean | undefined
}
// WARNING: do not attempt to make this function async!!! it will make it a lot slower!
function renderWithLevel(
	elem: PromptElement,
	level: number,
	tokenizer: PriomptTokenizer,
	callEjectedCallback?: boolean,
	sourceInfo?: SourceInfo
): RenderWithLevelPartialType {

	// High level, rather than constructing a new object at each recursive call, we'll just accumulate the result as we go.
	// This saves on a massive amount of allocations for large prompt trees and significantly improves
	// performance (around 10x for this function based on benchmarks).
	const result: RenderWithLevelPartialType = {
		prompt: undefined,
		emptyTokenCount: 0,
		outputHandlers: [],
		streamHandlers: [],
		streamResponseObjectHandlers: [],
		config: emptyConfig(),
	};

	function renderWithLevelInPlace(elem: PromptElement, sourceInfo?: SourceInfo): SourceMap | undefined {
		if (elem === undefined || elem === null || elem === false) {
			return undefined;
		}
		if (Array.isArray(elem)) {
			const sourceMaps = elem.map(
				(e, i) => renderWithLevelInPlace(
					e,
					sourceInfo !== undefined ? {
						name: `${i}`,
						isLast: (sourceInfo.isLast === undefined || sourceInfo.isLast === true) && i === elem.length - 1,
					} : undefined
				)
			);
			return sourceInfo === undefined ? undefined : mergeSourceMaps(sourceMaps, sourceInfo.name);
		}
		if (typeof elem === 'string') {
			result.prompt = sumPrompts(result.prompt, elem);
			return sourceInfo === undefined ? undefined : {
				name: sourceInfo.name,
				children: undefined,
				start: 0,
				end: elem.length,
				string: elem
			}
		}
		if (typeof elem === 'number') {
			const prompt = elem.toString();
			result.prompt = sumPrompts(result.prompt, prompt);
			return sourceInfo === undefined ? undefined : {
				name: sourceInfo.name,
				start: 0,
				end: prompt.length,
				string: prompt
			};
		}
		switch (elem.type) {
			case 'first': {
				for (const [i, child] of elem.children.entries()) {
					if (child.absolutePriority === undefined) {
						throw new Error(`BUG!! computePriorityLevels should have set absolutePriority for all children of first`);
					}
					if (child.absolutePriority >= level) {
						elem.onInclude?.();
						return renderWithLevelInPlace(child, sourceInfo !== undefined ? {
							name: `${sourceInfo.name}.${i}`,
							isLast: (sourceInfo.isLast === undefined || sourceInfo.isLast === true) && i === elem.children.length - 1,
						} : undefined);
					} else if (callEjectedCallback === true) {
						recursivelyEject(child);
					}
				}
				// nothing rendered from first, which is ok
				return undefined;
			}
			case 'capture': {
				if (elem.onOutput !== undefined) result.outputHandlers.push(elem.onOutput);
				if (elem.onStream !== undefined) result.streamHandlers.push(elem.onStream);
				if (elem.onStreamResponseObject !== undefined) result.streamResponseObjectHandlers.push(elem.onStreamResponseObject);
				return undefined;
			}
			case 'config': {
				result.config = mergeConfigsInPlace(result.config, elem);
				return undefined;
			}
			case 'breaktoken': {
				result.prompt = sumPrompts(result.prompt, ['', '']);
				return undefined;
			}
			case 'empty': {
				if (elem.tokenCount === undefined) {
					throw new Error(`BUG!! empty token count is undefined. THIS SHOULD NEVER HAPPEN. BUG IN PRIOMPT.Empty token count should've been hydrated first!`);
				}
				result.emptyTokenCount += elem.tokenCount;
				return undefined;
			}
			case 'functionDefinition': {
				result.prompt = sumPrompts(result.prompt, {
					type: 'text',
					text: "",
					functions: [
						{
							name: elem.name,
							description: elem.description,
							parameters: elem.parameters,
						}
					]
				});
				// Function defintions don't have source maps
				return undefined;
			}
			case 'toolDefinition': {
				result.prompt = sumPrompts(result.prompt, {
					type: 'text',
					text: "",
					tools: [
						{
							type: 'function',
							function: {
								name: elem.tool.function.name,
								description: elem.tool.function.description,
								parameters: elem.tool.function.parameters,
							}
						}
					]
				});
				// Tool definitions don't have source maps
				return undefined;
			}
			case 'isolate': {
				// check if we have a cached prompt
				if (elem.cachedRenderOutput === undefined) {
					// throw error! we need to hydrate the isolates first!
					throw new Error(`BUG!! Isolates should have been hydrated before calling renderWithLevelAndEarlyExitWithTokenEstimation`);
				}
				result.prompt = sumPrompts(result.prompt, elem.cachedRenderOutput.prompt);
				result.emptyTokenCount += elem.cachedRenderOutput.tokensReserved;
				result.outputHandlers.push(...elem.cachedRenderOutput.outputHandlers);
				result.streamHandlers.push(...elem.cachedRenderOutput.streamHandlers);
				result.streamResponseObjectHandlers.push(...elem.cachedRenderOutput.streamResponseObjectHandlers);
				return elem.cachedRenderOutput.sourceMap;
			}
			case 'scope': {
				if (elem.absolutePriority === undefined) {
					throw new Error(`BUG!! computePriorityLevels should have set absolutePriority for all scopes`);
				}
				if (elem.absolutePriority >= level) {
					elem.onInclude?.();
					const sourceMap = renderWithLevelInPlace(elem.children, sourceInfo !== undefined ? {
						name: elem.name ?? 'scope',
						isLast: sourceInfo.isLast,
					} : undefined);
					return (sourceMap === undefined || sourceInfo === undefined) ? undefined : {
						name: sourceInfo.name,
						children: [sourceMap],
						start: 0,
						end: sourceMap.end
					}
				} else if (callEjectedCallback === true) {
					recursivelyEject(elem);
				}
				return undefined;
			}

			case 'image': {
				const base64EncodedBytes = Buffer.from(elem.bytes).toString('base64');
				const mediaType = getImageMimeType(elem.bytes);
				result.prompt = sumPrompts(result.prompt, {
					type: 'prompt_content',
					content: [],
					images: [{
						type: 'image_url',
						image_url: {
							url: `data:${mediaType};base64,${base64EncodedBytes}`,
							detail: elem.detail,
							dimensions: elem.dimensions,
						}
					}],
				});
				// No source maps for images
				return undefined;
			}
			case 'chat': {
				// Chat requires special handling because we need to check if any of the children are chat messages
				// along with a lot of special logic based on the child types, so just use the outer renderWithLevel
				// rather than a renderInPlace. Chat prompts don't show up that often in the tree, so its fine to do this.
				const p = renderWithLevel(elem.children, level, tokenizer, callEjectedCallback, sourceInfo !== undefined ? {
					name: `${elem.role}-message`,
					isLast: undefined,
				} : undefined);
				if (isChatPrompt(p.prompt)) {
					throw new Error(`Incorrect prompt: we have nested chat messages, which is not allowed!`);
				}

				let message: ChatPromptMessage;
				if (elem.role === 'user') {
					if (isPromptContent(p.prompt)) {
						message = {
							role: elem.role,
							name: elem.name,
							to: elem.to,
							content: p.prompt.content,
							images: p.prompt.images
						};
					} else {
						message = {
							role: elem.role,
							name: elem.name,
							to: elem.to,
							content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
						};
					}
				} else if (elem.role === 'system') {
					if (isPromptContent(p.prompt)) {
						throw new Error('Did not expect images in system message')
					}
					message = {
						role: elem.role,
						to: elem.to,
						name: elem.name,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					};
				} else if (elem.role === 'assistant') {
					if (isPromptContent(p.prompt)) {
						throw new Error('Did not expect images in assistant message')
					}
					if (elem.functionCall !== undefined) {
						message = {
							role: elem.role,
							to: elem.to,
							content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text),
							functionCall: elem.functionCall,
						}
					} else if (elem.toolCalls !== undefined) {
						message = {
							role: elem.role,
							to: elem.to,
							content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text),
							toolCalls: elem.toolCalls,
						}
					} else {
						message = {
							role: elem.role,
							to: elem.to,
							content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
						}
					}
				} else if (elem.role === 'function') {
					if (isPromptContent(p.prompt)) {
						throw new Error('Did not expect images in function message')
					}
					message = {
						role: elem.role,
						to: elem.to,
						name: elem.name,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					}
				} else if (elem.role === 'tool') {
					if (isPromptContent(p.prompt)) {
						throw new Error('Did not expect images in tool message')
					}
					message = {
						role: elem.role,
						name: elem.name,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					}
				} else {
					const x: never = elem.role;
					throw new Error(`BUG!! Invalid role ${elem.role}`);
				}
				let sourceMap = p.sourceMap;
				if (sourceInfo !== undefined && p.sourceMap !== undefined) {
					sourceMap = getSourceMapForChat(message, tokenizer, p.sourceMap, sourceInfo);
				}
				result.prompt = sumPrompts(result.prompt, {
					type: 'chat',
					messages: [message],
					functions: promptHasFunctions(p.prompt) ? p.prompt.functions : undefined,
					tools: promptHasTools(p.prompt) ? p.prompt.tools : undefined,
				});
				result.emptyTokenCount += p.emptyTokenCount;
				result.outputHandlers.push(...p.outputHandlers);
				result.streamHandlers.push(...p.streamHandlers);
				result.streamResponseObjectHandlers.push(...p.streamResponseObjectHandlers);
				return sourceMap;
			}
		}
	}
	const sourceMap = renderWithLevelInPlace(elem, sourceInfo);
	result.sourceMap = sourceMap;
	return result;
}

const getSourceMapForChat = (message: ChatPromptMessage, tokenizer: PriomptTokenizer, sourceMap: SourceMap, sourceInfo: SourceInfo) => {
	let headerStringForMessage;
	if (message.role === 'function') {
		console.error("SourceMap not implemented for functions");
		headerStringForMessage = "";
	} else {
		headerStringForMessage = tokenizer.getHeaderStringForMessage(message);
	}
	const children = [
		{
			name: 'header',
			children: [],
			start: 0,
			end: headerStringForMessage.length
		},
		{
			...sourceMap,
			start: headerStringForMessage.length,
			end: sourceMap.end + headerStringForMessage.length
		}
	]
	if (sourceInfo.isLast === null) {
		throw new Error(`BUG!! source.isLast should not be null`);
	}
	if ((sourceInfo.isLast === false) && tokenizer.shouldAddEosTokenToEachMessage) {
		children.push({
			name: 'eos',
			children: [],
			start: children[children.length - 1].end,
			end: children[children.length - 1].end + tokenizer.getEosToken().length
		})
	}
	return {
		name: 'chat',
		children,
		start: 0,
		end: children[children.length - 1].end
	}
}

const normalizeSourceMap = (sourceMap: SourceMap): SourceMap => {
	if (sourceMap.children === undefined) {
		return sourceMap
	}
	if (sourceMap.children.length === 0) {
		sourceMap.children = undefined
		return sourceMap
	}
	if (sourceMap.children.length === 1) {
		return normalizeSourceMap({
			name: `${sourceMap.name}.${sourceMap.children[0].name}`,
			children: sourceMap.children[0].children,
			start: sourceMap.start,
			end: sourceMap.end
		})
	} else {
		return {
			...sourceMap,
			children: sourceMap.children.map(normalizeSourceMap),
		}
	}
}

const mergeSourceMaps = (sourceMaps: (SourceMap | undefined)[], sourceName: string): SourceMap | undefined => {
	// We need to shift all of the non-root sourceMaps
	const filteredSourceMaps = sourceMaps.filter(s => s !== undefined) as SourceMap[];
	if (filteredSourceMaps.length === 0) {
		return undefined
	}
	const shiftedSourceMaps = [filteredSourceMaps[0]]
	let maxEnd = filteredSourceMaps[0].end;
	for (let i = 1; i < filteredSourceMaps.length; i++) {
		const nextSourceMap = filteredSourceMaps[i];
		if (nextSourceMap === undefined) {
			continue;
		}
		const newBase = shiftedSourceMaps[shiftedSourceMaps.length - 1].end;
		nextSourceMap.start += newBase;
		nextSourceMap.end += newBase;
		maxEnd = Math.max(maxEnd, nextSourceMap.end);
		shiftedSourceMaps.push(nextSourceMap)
	}
	return {
		name: sourceName,
		children: shiftedSourceMaps,
		start: 0,
		end: maxEnd,
	}
}

export const absolutifySourceMap = (sourceMap: SourceMap, offset: number = 0): AbsoluteSourceMap => {
	const absoluteStart = sourceMap.start + offset;
	return {
		...sourceMap,
		start: absoluteStart,
		end: sourceMap.end + offset,
		children: sourceMap.children?.map(child => absolutifySourceMap(child, absoluteStart)) || undefined,
		__brand: 'absolute'
	};
}

export const querySourceMap = (absoluteSourceMap: AbsoluteSourceMap, position: number, sourceName: string = ''): string => {
	if (position < absoluteSourceMap.start || position >= absoluteSourceMap.end) {
		console.error('Position out of bounds', JSON.stringify({ position, sourceName, start: absoluteSourceMap.start, end: absoluteSourceMap.end }, null, 2))
		throw new Error('Position out of bounds');
	}
	const combinedName = [sourceName, absoluteSourceMap.name].filter(Boolean).join('.');
	if (absoluteSourceMap.children !== undefined) {
		for (const child of absoluteSourceMap.children) {
			if (position >= child.start && position < child.end) {
				return querySourceMap(child, position, combinedName);
			}
		}
	}
	return combinedName;
}


// TODO: make this into eslint rules so they can be shown in the IDE
function validateUnrenderedPrompt(elem: PromptElement): void {
	if (isDev()) {
		validateNoChildrenHigherPriorityThanParent(elem);
		// print a warning if any scope has both an absolute and relative priority
		validateNotBothAbsoluteAndRelativePriority(elem);
	}
}

function validateNoUnhandledTypes(elem: PromptElement): void {
	if (Array.isArray(elem)) {
		for (const child of elem) {
			validateNoUnhandledTypes(child);
		}
		return;
	}

	if (elem === undefined || elem === null || elem === false) {
		return;
	}

	if (typeof elem === 'string') {
		return;
	}
	if (typeof elem === 'number') {
		return;
	}

	switch (elem.type) {
		case 'functionDefinition':
		case 'toolDefinition':
		case 'image':
		case 'empty': {
			return;
		}
		case 'chat':
		case 'scope': {
			validateNoUnhandledTypes(elem.children);
			return;
		}
		case 'isolate':
		case 'breaktoken':
		case 'config':
		case 'capture':
		case 'first': {
			throw new Error(`Priompt ERROR: prompt element type ${elem.type} is not handled`);
		}
	}

}


function validateNotBothAbsoluteAndRelativePriority(elem: PromptElement): void {
	if (Array.isArray(elem)) {
		for (const child of elem) {
			validateNotBothAbsoluteAndRelativePriority(child);
		}
		return;
	}

	if (elem === undefined || elem === null || elem === false) {
		return;
	}

	if (typeof elem === 'string') {
		return;
	}
	if (typeof elem === 'number') {
		return;
	}

	switch (elem.type) {
		case 'chat':
		case 'isolate':
		case 'first': {
			for (const child of elem.children) {
				validateNotBothAbsoluteAndRelativePriority(child);
			}
			return;
		}
		case 'capture':
		case 'breaktoken':
		case 'functionDefinition':
		case 'toolDefinition':
		case 'image':
		case 'config':
		case 'empty': {
			return;
		}
		case 'scope': {
			if (elem.absolutePriority !== undefined && elem.relativePriority !== undefined) {
				console.warn(`Priompt WARNING: scope has both absolute and relative priority.This is discouraged.Ignoring relative priority.`);
			}
			for (const child of elem.children) {
				validateNotBothAbsoluteAndRelativePriority(child);
			}
			return;
		}
	}
}

function validateNoChildrenHigherPriorityThanParent(elem: PromptElement, parentPriority: number = BASE_PRIORITY): void {
	if (Array.isArray(elem)) {
		for (const child of elem) {
			validateNoChildrenHigherPriorityThanParent(child, parentPriority);
		}
		return;
	}

	if (elem === undefined || elem === null || elem === false) {
		return;
	}

	if (typeof elem === 'string') {
		return;
	}
	if (typeof elem === 'number') {
		return;
	}

	switch (elem.type) {
		case 'chat':
		case 'first': {
			for (const child of elem.children) {
				validateNoChildrenHigherPriorityThanParent(child, parentPriority);
			}
			return;
		}
		case 'isolate': {
			// we explicitly do not send in the parent priority because the isolate is isolated!!
			validateNoChildrenHigherPriorityThanParent(elem.children);
			return;
		}
		case 'capture':
		case 'image':
		case 'breaktoken':
		case 'functionDefinition':
		case 'toolDefinition':
		case 'empty':
		case 'config': {
			return;
		}
		case 'scope': {
			const priority = computePriority(elem, parentPriority);
			if (priority > parentPriority) {
				console.warn(`Priompt WARNING: child scope has a higher priority(${priority}) than its parent(${parentPriority}).This is discouraged, because the child will only be included if the parent is, and thus the effective priority of the child is just the parent's priority.`);
			}
			for (const child of elem.children) {
				validateNoChildrenHigherPriorityThanParent(child, priority);
			}
			return;
		}
	}
}

function computePriority(elem: Scope | NormalizedScope, parentPriority: number) {
	return elem.absolutePriority ?? (parentPriority + (elem.relativePriority ?? 0));
}

type AnyNode = NormalizedNode | Node;

function computePriorityLevels(elem: AnyNode[] | AnyNode, parentPriority: number, levels: Set<number>): void {
	if (Array.isArray(elem)) {
		for (const child of elem) {
			computePriorityLevels(child, parentPriority, levels);
		}
		return;
	}

	if (elem === undefined || elem === null || elem === false) {
		return;
	}

	if (typeof elem === 'string') {
		return;
	}

	if (typeof elem === 'number') {
		return;
	}

	switch (elem.type) {
		case 'chat':
		case 'first': {
			// just do it for each child
			for (const child of elem.children) {
				computePriorityLevels(child, parentPriority, levels);
			}
			return;
		}
		case 'image':
		case 'capture':
		case 'functionDefinition':
		case 'toolDefinition':
		case 'breaktoken':
		case 'config':
		case 'empty': {
			// nothing happens
			return;
		}
		case 'isolate': {
			// nothing happens because we fully re-render
			return;
		}
		case 'scope': {
			// compute the priority of this scope
			// the absolutePriority takes precedence over the relativePriority
			const priority = computePriority(elem, parentPriority);
			levels.add(priority);
			// we make the elem have this priority, so that we don't need to redo the priority calculation
			elem.absolutePriority = priority;
			// then for each child
			for (const child of elem.children) {
				computePriorityLevels(child, priority, levels);
			}
			return;
		}
		case 'normalizedString': {
			// nothing happens
			return;
		}
	}

}

type Countables = FunctionDefinition | NormalizedFunctionDefinition | ToolDefinition | NormalizedToolDefinition | string | number
function computePriorityLevelsTokensMapping(elem: NormalizedNode[] | NormalizedNode, parentPriority: number, mapping: Record<number, Countables[]>): void {

	if (Array.isArray(elem)) {
		for (const child of elem) {
			computePriorityLevelsTokensMapping(child, parentPriority, mapping);
		}
		return;
	}

	switch (elem.type) {
		case 'empty': {
			if (elem.tokenCount === undefined) {
				throw new Error(`BUG!! empty token count is undefined. THIS SHOULD NEVER HAPPEN. BUG IN PRIOMPT.Empty token count should've been hydrated first!`);
			}
			if (!(parentPriority in mapping)) {
				mapping[parentPriority] = [];
			}
			mapping[parentPriority].push(elem.tokenCount);
			return
		}
		case 'functionDefinition': {
			if (!(parentPriority in mapping)) {
				mapping[parentPriority] = [];
			}
			mapping[parentPriority].push(elem);
			return;
		}
		case 'toolDefinition': {
			if (!(parentPriority in mapping)) {
				mapping[parentPriority] = [];
			}
			mapping[parentPriority].push(elem);
			return;
		}
		case 'chat': {
			if (!(parentPriority in mapping)) {
				mapping[parentPriority] = [];
			}
			mapping[parentPriority].push(CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT);
			for (const child of elem.children) {
				computePriorityLevelsTokensMapping(child, parentPriority, mapping);
			}
			return;

		}
		case 'scope': {
			const priority = computePriority(elem, parentPriority);
			elem.absolutePriority = priority;

			if (!(priority in mapping)) {
				mapping[priority] = [];
			}

			for (const child of elem.children) {
				computePriorityLevelsTokensMapping(child, priority, mapping);
			}
			return;
		}
		case 'normalizedString': {
			if (!(parentPriority in mapping)) {
				mapping[parentPriority] = [];
			}

			mapping[parentPriority].push(elem.s);
			return;
		}
		case 'isolate':
		case 'breaktoken':
		case 'capture':
		case 'config':
		case 'image':
		case 'first': {
			throw new Error(`BUG!! computePriorityLevelsTokensMapping should not be called on a ${elem.type}!`);
		}
	}
}

async function numTokensPromptString(p: PromptString, tokenizer: PriomptTokenizer): Promise<number> {
	if (Array.isArray(p)) {
		// should be tokenized independently!!!!!!!
		const t = await Promise.all(p.map(s => tokenizer.numTokens(s)));
		return t.reduce((a, b) => a + b, 0);
	}
	return tokenizer.numTokens(p);
}

async function numTokensPromptStringFast_UNSAFE(prompt: PromptString, tokenizer: PriomptTokenizer): Promise<number> {
	if (Array.isArray(prompt)) {
		let tokens = 0;
		for (const p of prompt) {
			tokens += await numTokensPromptStringFast_UNSAFE(p, tokenizer);
		}
		return tokens;
	}
	return tokenizer.estimateNumTokensFast(prompt);
}

async function countTokensApproxFast_UNSAFE(tokenizer: PriomptTokenizer, prompt: RenderedPrompt, options: {
	lastMessageIsIncomplete?: boolean;
}): Promise<number> {
	let tokens = 0;
	if (isPlainPrompt(prompt)) {
		tokens += await numTokensPromptStringFast_UNSAFE(prompt, tokenizer);
	} else if (isChatPrompt(prompt)) {
		const msgTokens = prompt.messages.map(msg => countMsgTokensFast_UNSAFE(msg, tokenizer));
		// docs here: https://platform.openai.com/docs/guides/chat/introduction
		tokens += (await Promise.all(msgTokens)).reduce((a, b) => a + b, 0) + CHATML_PROMPT_EXTRA_TOKEN_COUNT_LINEAR_FACTOR * (prompt.messages.length) + CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT;
		if (options.lastMessageIsIncomplete === true) {
			// one for the <|im_end|>
			tokens = tokens - (CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT + 1);
		}
	} else if (isPromptContent(prompt)) {
		// We count the tokens of each text element
		tokens += await numTokensPromptStringFast_UNSAFE(prompt.content, tokenizer);
		if (prompt.images) {
			prompt.images.forEach(image => {
				// Fine because sync anyways
				tokens += numTokensForImage(image.image_url.dimensions, image.image_url.detail)
			});
		}
	} else {
		tokens += await numTokensPromptStringFast_UNSAFE(prompt.text, tokenizer);
	}
	if (promptHasFunctions(prompt)) {
		// we assume an extra 2 tokens per function
		const functionTokens = prompt.functions.map((func) => {
			return countFunctionTokensApprox_SYNCHRONOUS_BE_CAREFUL(func, tokenizer) + 2;
		});
		tokens += functionTokens.reduce((a, b) => a + b, 0);
	}
	if (promptHasTools(prompt)) {
		// we assume an extra 2 tokens per tool
		const toolTokens = prompt.tools.map((tool) => {
			return countToolTokensApprox_SYNCHRONOUS_BE_CAREFUL(tool, tokenizer) + 2;
		});
		tokens += toolTokens.reduce((a, b) => a + b, 0);
	}
	return tokens;
}
async function countTokensExact(tokenizer: PriomptTokenizer, prompt: RenderedPrompt, options: {
	lastMessageIsIncomplete?: boolean;
}): Promise<number> {
	let tokens = 0;
	if (isPlainPrompt(prompt)) {
		tokens += await numTokensPromptString(prompt, tokenizer);
	} else if (isChatPrompt(prompt)) {
		const msgTokens = await Promise.all(prompt.messages.map(msg => countMsgTokens(msg, tokenizer)));
		// docs here: https://platform.openai.com/docs/guides/chat/introduction
		tokens += msgTokens.reduce((a, b) => a + b, 0) + CHATML_PROMPT_EXTRA_TOKEN_COUNT_LINEAR_FACTOR * (prompt.messages.length) + CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT;
		if (options.lastMessageIsIncomplete === true) {
			// one for the <|im_end|>
			tokens = tokens - (CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT + 1);
		}
	} else if (isPromptContent(prompt)) {
		// We count the tokens of each text element
		tokens += await numTokensPromptString(prompt.content, tokenizer);
		if (prompt.images) {
			prompt.images.forEach(image => {
				tokens += numTokensForImage(image.image_url.dimensions, image.image_url.detail)
			});

		}
	} else {
		tokens += await numTokensPromptString(prompt.text, tokenizer);
	}
	if (promptHasFunctions(prompt)) {
		// we assume an extra 2 tokens per function
		const functionTokens = await Promise.all(prompt.functions.map(async (func) => {
			return await countFunctionTokens(func, tokenizer) + 2;
		}));
		tokens += functionTokens.reduce((a, b) => a + b, 0);
	}
	if (promptHasTools(prompt)) {
		// we assume an extra 2 tokens per tool
		const toolTokens = await Promise.all(prompt.tools.map(async (tool) => {
			return await countToolTokens(tool, tokenizer) + 2;
		}));
		tokens += toolTokens.reduce((a, b) => a + b, 0);
	}
	return tokens;
}

// TODO: swap this with newer version of openai api
export function promptToOpenAIChatRequest(prompt: RenderedPrompt): { messages: Array<ChatCompletionRequestMessage>; functions: ChatCompletionFunctions[] | undefined; tools: ChatAndToolPromptToolFunction[] | undefined, tool_choice?: 'auto' } {
	const functions = promptHasFunctions(prompt) ? prompt.functions : undefined;
	const tools = promptHasTools(prompt) ? prompt.tools : undefined;
	const messages = promptToOpenAIChatMessages(prompt);
	return {
		messages,
		functions,
		tools,
		tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
	};
}


export function contentArrayToStringContent(content: Array<string | PromptContent>): string[] {
	const newContent: string[] = []
	content.forEach(c => {
		if (typeof c === 'string') {
			newContent.push(c);
		} else if (c.type === 'text') {
			newContent.push(c.text);
		} else if (c.type === 'image_url') {
			// Do nothing with images
		}
	});
	return newContent;

}

// a piece of context, e.g. a scraped doc, could include <|im_end|> strings and mess up the prompt... so please don't use it unless necessary
// it also does not have <breaktoken> support
export function promptToString_VULNERABLE_TO_PROMPT_INJECTION(prompt: RenderedPrompt, tokenizer: PriomptTokenizer): string {
	if (isPlainPrompt(prompt)) {
		// we should just encode it as a plain prompt!
		let s = "";
		if (Array.isArray(prompt)) {
			s = prompt.join('');
		} else {
			s = prompt;
		}
		return s;
	} else if (isChatPrompt(prompt)) {
		const parts = prompt.messages.map((msg) => {
			if (msg.role === 'function') {
				// let's just throw
				throw new Error(`BUG!! promptToString got a chat prompt with a function message, which is not supported yet!`);
			} else if (msg.role === 'assistant' && msg.functionCall !== undefined) {
				throw new Error(`BUG!! promptToString got a chat prompt with a function message, which is not supported yet!`);
			} else {
				const headerTokens = tokenizer.getHeaderStringForMessage(msg);
				let newContent: string[] | string | undefined = undefined
				if (Array.isArray(msg.content)) {
					// We just combine the tokens to a string array to get around images
					newContent = contentArrayToStringContent(msg.content);
				} else {
					newContent = msg.content;
				}
				return headerTokens + (newContent !== undefined ? (promptToString_VULNERABLE_TO_PROMPT_INJECTION(newContent, tokenizer)) : "");
			}
		});
		let final: string = "";
		for (const part of parts) {
			if (final.length > 0) {
				final += tokenizer.getEosToken();
			}
			final += part;
		}
		return final;
	}
	throw new Error(`BUG!! promptToString got an invalid prompt`);
}

// always leaves the last message "open"
export async function promptToTokens(prompt: RenderedPrompt, tokenizer: PriomptTokenizer): Promise<number[]> {
	if (isPlainPrompt(prompt)) {
		// we should just encode it as a plain prompt!
		if (Array.isArray(prompt)) {
			const tokens = await Promise.all(prompt.map(s => tokenizer.encodeTokens(s)));
			return tokens.reduce((a, b) => a.concat(b), []);
		}
		return tokenizer.encodeTokens(prompt);
	} else if (isChatPrompt(prompt)) {
		const messages = prompt.messages;
		messages.forEach(msg => {
			if (msg.role === 'function') {
				throw new Error(`BUG!! promptToTokens got a chat prompt with a function message, which is not supported yet!`);
			} else if (msg.role === 'assistant' && msg.functionCall !== undefined) {
				throw new Error(`BUG!! promptToTokens got a chat prompt with a function message, which is not supported yet!`);
			} else if (msg.content === undefined) {
				throw new Error(`BUG!! promptToTokens got a chat prompt with a message that is undefined!`);
			}
		})

		return await tokenizer.applyChatTemplateTokens(messages as {
			role: OpenAIMessageRole,
			name?: string,
			to?: string,
			content: string | string[]
		}[])
	}
	throw new Error(`BUG!! promptToTokens got an invalid prompt`);
}

export function openAIChatMessagesToPrompt(messages: ChatCompletionRequestMessage[]): ChatPrompt {
	return {
		type: "chat",
		messages: messages.map(m => {
			let c: ChatPromptMessage;
			if (Array.isArray(m.content)) {
				if (m.role === "function") {
					c = {
						role: "function",
						to: undefined,
						content: m.content.map(c => c.type === 'text' ? c.text : "").join(""),
						name: m.name ?? "",
					}
					return c;
				}
				c = {
					role: m.role,
					to: undefined,
					content: m.content.map(c => c.type === 'text' ? c.text : "").join(""),
					images: m.content.filter(c => c.type === 'image_url') as ImagePromptContent[],
				}
				return c;
			} else {
				if (m.role === "function") {
					c = {
						role: "function",
						to: undefined,
						content: m.content ?? "",
						name: m.name ?? "",
					}
					return c;
				}
				c = {
					role: m.role,
					to: undefined,
					content: m.content ?? ""
				}
				return c;
			}
		})
	}
}

export function promptToOpenAIChatMessages(prompt: RenderedPrompt): Array<ChatCompletionRequestMessage> {
	if (isPlainPrompt(prompt)) {
		return [
			{
				role: 'user',
				content: promptStringToString(prompt)
			}
		];
	} else if (isChatPrompt(prompt)) {
		return prompt.messages.map(msg => {
			if (msg.role === 'function') {
				return {
					role: msg.role,
					name: msg.name,
					content: promptStringToString(msg.content),
				}
			} else if (msg.role === 'tool') {
				return {
					role: 'tool',
					name: msg.name,
					tool_call_id: msg.to,
					content: promptStringToString(msg.content),
				}
			} else if (msg.role === 'assistant' && msg.functionCall !== undefined) {
				return {
					role: msg.role,
					content: msg.content !== undefined ? promptStringToString(msg.content) : "", // openai is lying when they say this should not be provided
					function_call: msg.functionCall,
				}
			} else if (msg.role === 'assistant' && msg.toolCalls !== undefined) {
				return {
					role: msg.role,
					content: msg.content !== undefined ? promptStringToString(msg.content) : "", // openai is lying when they say this should not be provided
					tool_calls: msg.toolCalls?.map(toolCall => ({
						type: 'function',
						id: toolCall.id,
						index: toolCall.index,
						function: {
							name: toolCall.tool.function.name,
							arguments: toolCall.tool.function.arguments,
						}
					}))
				}
			} else if (msg.role === 'assistant') {
				return {
					role: msg.role,
					content: msg.content !== undefined ? promptStringToString(msg.content) : "", // openai is lying when they say this should not be provided
				}
			} else if (msg.role === 'system') {
				return {
					role: msg.role,
					name: msg.name,
					content: msg.content !== undefined ? promptStringToString(msg.content) : "", // openai is lying when they say this should not be provided
				}
			} else {
				if (msg.images && msg.images.length > 0) {
					// We format the content
					const content: Content[] = [];
					// First, we add the image
					content.push(...msg.images)
					// Then we add the text
					const textContent = msg.content !== undefined ? promptStringToString(msg.content) : "";
					content.push({
						type: 'text',
						text: textContent
					})
					// Import new openai api version to support images
					return {
						role: msg.role,
						content: content,
						name: 'name' in msg ? msg.name : undefined,
					}
				} else {
					return {
						role: msg.role,
						content: msg.content !== undefined ? promptStringToString(msg.content) : '',
						name: 'name' in msg ? msg.name : undefined,
					}
				}
			}
		});
	}
	throw new Error(`BUG!! promptToOpenAIChatMessagesgot an invalid prompt`);
}

async function countMsgTokensFast_UNSAFE(message: ChatPromptMessage, tokenizer: PriomptTokenizer): Promise<number> {
	if (message.role === 'function') {
		// add an extra 2 tokens for good measure
		return (await tokenizer.estimateNumTokensFast(message.name)) + (await numTokensPromptStringFast_UNSAFE(message.content, tokenizer)) + 2;
	} else if (message.role === 'assistant' && message.functionCall !== undefined) {
		return (await countFunctionCallMessageTokensFast_UNSAFE(message.functionCall, tokenizer)) + (message.content !== undefined ? (await numTokensPromptStringFast_UNSAFE(message.content, tokenizer)) : 0);
	} else {
		let numTokens = await numTokensPromptStringFast_UNSAFE(message.content ?? "", tokenizer);
		if (message.role === 'user' && message.images !== undefined) {
			message.images.forEach(image => {
				// numTokensForImage is synchronous and fast anyways, so nothing needed here
				numTokens += numTokensForImage(image.image_url.dimensions, image.image_url.detail);
			});
		}
		return numTokens;
	}
}
export async function countMsgTokens(message: ChatPromptMessage, tokenizer: PriomptTokenizer): Promise<number> {
	if (message.role === 'function') {
		// add an extra 2 tokens for good measure
		return (await tokenizer.numTokens(message.name)) + (await numTokensPromptString(message.content, tokenizer)) + 2;
	} else if (message.role === 'assistant' && message.functionCall !== undefined) {
		return (await countFunctionCallMessageTokens(message.functionCall, tokenizer)) + (message.content !== undefined ? (await numTokensPromptString(message.content, tokenizer)) : 0);
	} else {
		let numTokens = await numTokensPromptString(message.content ?? "", tokenizer);
		if (message.role === 'user' && message.images !== undefined) {
			message.images.forEach(image => {
				numTokens += numTokensForImage(image.image_url.dimensions, image.image_url.detail);
			});
		}
		return numTokens;
	}
}

async function countFunctionCallMessageTokens(functionCall: { name: string; arguments: string; }, tokenizer: PriomptTokenizer): Promise<number> {
	// add some constant factor here because who knows what's actually going on with functions
	return (await tokenizer.numTokens(functionCall.name)) + (await tokenizer.numTokens(functionCall.arguments)) + 5;
}
async function countFunctionCallMessageTokensFast_UNSAFE(functionCall: { name: string; arguments: string; }, tokenizer: PriomptTokenizer): Promise<number> {
	// add some constant factor here because who knows what's actually going on with functions
	return (await tokenizer.estimateNumTokensFast(functionCall.name)) + (await tokenizer.estimateNumTokensFast(functionCall.arguments)) + 5;
}

async function countFunctionTokens(functionDefinition: ChatAndFunctionPromptFunction, tokenizer: PriomptTokenizer): Promise<number> {
	// hmmmm how do we count these tokens? openai has been quite unclear
	// for now we JSON stringify and count tokens, and hope that that is reasonably close
	const stringifiedFunction = JSON.stringify({
		name: functionDefinition.name,
		description: functionDefinition.description,
		parameters: functionDefinition.parameters,
	}, null, 2);
	// we multiply by 1.5 and add 10 just to be safe until we've done more testing
	const raw = await tokenizer.numTokens(stringifiedFunction);
	return Math.ceil(raw * 1.5) + 10;
}

async function countToolTokens(toolDefinition: ChatAndToolPromptToolFunction, tokenizer: PriomptTokenizer): Promise<number> {
	// hmmmm how do we count these tokens? openai has been quite unclear
	// for now we JSON stringify and count tokens, and hope that that is reasonably close
	const stringifiedTool = JSON.stringify({
		name: toolDefinition.function.name,
		description: toolDefinition.function.description,
		parameters: toolDefinition.function.parameters,
	}, null, 2);
	// we multiply by 1.5 and add 10 just to be safe until we've done more testing
	const raw = await tokenizer.numTokens(stringifiedTool);
	return Math.ceil(raw * 1.5) + 10;
}

function countFunctionTokensApprox_SYNCHRONOUS_BE_CAREFUL(functionDefinition: ChatAndFunctionPromptFunction, tokenizer: PriomptTokenizer): number {
	// hmmmm how do we count these tokens? openai has been quite unclear
	// for now we JSON stringify and count tokens, and hope that that is reasonably close
	const stringifiedFunction = JSON.stringify({
		name: functionDefinition.name,
		description: functionDefinition.description,
		parameters: functionDefinition.parameters,
	}, null, 2);
	// we multiply by 1.5 and add 10 just to be safe until we've done more testing
	const raw = tokenizer.estimateNumTokensFast_SYNCHRONOUS_BE_CAREFUL(stringifiedFunction);
	return Math.ceil(raw * 1.5) + 10;
}

function countToolTokensApprox_SYNCHRONOUS_BE_CAREFUL(toolDefinition: ChatAndToolPromptToolFunction, tokenizer: PriomptTokenizer): number {
	// hmmmm how do we count these tokens? openai has been quite unclear
	// for now we JSON stringify and count tokens, and hope that that is reasonably close
	const stringifiedTool = JSON.stringify({
		name: toolDefinition.function.name,
		description: toolDefinition.function.description,
		parameters: toolDefinition.function.parameters,
	}, null, 2);
	// we multiply by 1.5 and add 10 just to be safe until we've done more testing
	const raw = tokenizer.estimateNumTokensFast_SYNCHRONOUS_BE_CAREFUL(stringifiedTool);
	return Math.ceil(raw * 1.5) + 10;
}


function estimateFunctionTokensUsingCharcount(functionDefinition: ChatAndFunctionPromptFunction, tokenizer: PriomptTokenizer): [number, number] {
	const stringifiedFunction = JSON.stringify({
		name: functionDefinition.name,
		description: functionDefinition.description,
		parameters: functionDefinition.parameters,
	}, null, 2);
	const raw = tokenizer.estimateTokensUsingCharCount(stringifiedFunction);
	// we multiply by 1.5 and add 10 just to be safe until we've done more testing for the upper bound
	return [Math.ceil(raw[0] * 0.5), Math.ceil(raw[1] * 1.5) + 10];
}

function estimateToolTokensUsingCharcount(toolDefinition: ChatAndToolPromptToolFunction, tokenizer: PriomptTokenizer): [number, number] {
	const stringifiedTool = JSON.stringify({
		name: toolDefinition.function.name,
		description: toolDefinition.function.description,
		parameters: toolDefinition.function.parameters,
	}, null, 2);
	const raw = tokenizer.estimateTokensUsingCharCount(stringifiedTool);
	// we multiply by 1.5 and add 10 just to be safe until we've done more testing for the upper bound
	return [Math.ceil(raw[0] * 0.5), Math.ceil(raw[1] * 1.5) + 10];
}

function estimateLowerBoundTokensForPrompt(prompt: RenderedPrompt | undefined, tokenizer: PriomptTokenizer): number {
	if (prompt === undefined) {
		return 0;
	}
	let contentTokens;
	if (isChatPrompt(prompt)) {
		contentTokens = prompt.messages.reduce((a, b) => {
			if (b.role === 'function') {
				// since this is a lower bound, we assume there are no extra tokens here
				return a + tokenizer.estimateTokensUsingCharCount(b.name + b.content)[0];
			} else if (b.role === 'assistant' && b.functionCall !== undefined) {
				return a + tokenizer.estimateTokensUsingCharCount(b.functionCall.name + b.functionCall.arguments + (b.content ?? ""))[0];
			} else {
				return a + tokenizer.estimateTokensUsingCharCount(b.content !== undefined ? promptStringToString(b.content) : "")[0];
			}
		}, 0);
	} else if (isPlainPrompt(prompt)) {
		contentTokens = tokenizer.estimateTokensUsingCharCount(promptStringToString(prompt))[0];
	} else if (isPromptContent(prompt)) {
		contentTokens = tokenizer.estimateTokensUsingCharCount(promptStringToString(prompt.content))[0];
	} else {
		contentTokens = tokenizer.estimateTokensUsingCharCount(promptStringToString(prompt.text))[0];
	}

	const functionTokens = (promptHasFunctions(prompt) ? prompt.functions.reduce((a, b) => (a + estimateFunctionTokensUsingCharcount(b, tokenizer)[0]), 0) : 0);
	const toolTokens = (promptHasTools(prompt) ? prompt.tools.reduce((a, b) => (a + estimateToolTokensUsingCharcount(b, tokenizer)[0]), 0) : 0);

	return contentTokens + functionTokens + toolTokens;
}

export function getPromptElementNodeCount(elem: PromptElement): number {
	if (elem === undefined || elem === null || typeof elem === 'number' || typeof elem === 'boolean' || typeof elem === 'string') {
		return 1;
	}
	if (Array.isArray(elem)) {
		let nodeCount = 0;
		elem.forEach(p => {
			nodeCount += getPromptElementNodeCount(p);
		});
		return nodeCount;
	}
	switch (elem.type) {
		case 'functionDefinition':
		case 'toolDefinition':
		case 'breaktoken':
		case 'capture':
		case 'config':
		case 'empty':
		case 'image':
			return 1;
		case 'first':
		case 'isolate':
		case 'scope':
		case 'chat':
			return 1 + getPromptElementNodeCount(elem.children);
	}
}

export class TooManyTokensForBasePriority extends Error {
	constructor(message?: string) {
		super(message);
		this.name = "TooManyTokensForBasePriority";
	}
}
