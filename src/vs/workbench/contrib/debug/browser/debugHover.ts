/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as lifecycle from 'vs/base/common/lifecycle';
import { KeyCode } from 'vs/base/common/keyCodes';
import { ScrollbarVisibility } from 'vs/base/common/scrollable';
import * as dom from 'vs/base/browser/dom';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { ConfigurationChangedEvent, EditorOption } from 'vs/editor/common/config/editorOptions';
import { Position } from 'vs/editor/common/core/position';
import { Range, IRange } from 'vs/editor/common/core/range';
import { IContentWidget, ICodeEditor, IContentWidgetPosition, ContentWidgetPositionPreference } from 'vs/editor/browser/editorBrowser';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IDebugService, IExpression, IExpressionContainer, IStackFrame } from 'vs/workbench/contrib/debug/common/debug';
import { Expression } from 'vs/workbench/contrib/debug/common/debugModel';
import { renderExpressionValue } from 'vs/workbench/contrib/debug/browser/baseDebugView';
import { DomScrollableElement } from 'vs/base/browser/ui/scrollbar/scrollableElement';
import { attachStylerCallback } from 'vs/platform/theme/common/styler';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { editorHoverBackground, editorHoverBorder, editorHoverForeground } from 'vs/platform/theme/common/colorRegistry';
import { ModelDecorationOptions } from 'vs/editor/common/model/textModel';
import { getExactExpressionStartAndEnd } from 'vs/workbench/contrib/debug/common/debugUtils';
import { AsyncDataTree } from 'vs/base/browser/ui/tree/asyncDataTree';
import { IListAccessibilityProvider } from 'vs/base/browser/ui/list/listWidget';
import { IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { WorkbenchAsyncDataTree } from 'vs/platform/list/browser/listService';
import { coalesce } from 'vs/base/common/arrays';
import { IAsyncDataSource } from 'vs/base/browser/ui/tree/tree';
import { VariablesRenderer } from 'vs/workbench/contrib/debug/browser/variablesView';
import { EvaluatableExpressionProviderRegistry } from 'vs/editor/common/modes';
import { CancellationToken } from 'vs/base/common/cancellation';

const $ = dom.$;
const MAX_TREE_HEIGHT = 324;

async function doFindExpression(container: IExpressionContainer, namesToFind: string[]): Promise<IExpression | null> {
	if (!container) {
		return Promise.resolve(null);
	}

	const children = await container.getChildren();
	// look for our variable in the list. First find the parents of the hovered variable if there are any.
	const filtered = children.filter(v => namesToFind[0] === v.name);
	if (filtered.length !== 1) {
		return null;
	}

	if (namesToFind.length === 1) {
		return filtered[0];
	} else {
		return doFindExpression(filtered[0], namesToFind.slice(1));
	}
}

export async function findExpressionInStackFrame(stackFrame: IStackFrame, namesToFind: string[]): Promise<IExpression | undefined> {
	const scopes = await stackFrame.getScopes();
	const nonExpensive = scopes.filter(s => !s.expensive);
	const expressions = coalesce(await Promise.all(nonExpensive.map(scope => doFindExpression(scope, namesToFind))));

	// only show if all expressions found have the same value
	return expressions.length > 0 && expressions.every(e => e.value === expressions[0].value) ? expressions[0] : undefined;
}

export class DebugHoverWidget implements IContentWidget {

	static readonly ID = 'debug.hoverWidget';
	// editor.IContentWidget.allowEditorOverflow
	allowEditorOverflow = true;

	private _isVisible: boolean;
	private domNode!: HTMLElement;
	private tree!: AsyncDataTree<IExpression, IExpression, any>;
	private showAtPosition: Position | null;
	private highlightDecorations: string[];
	private complexValueContainer!: HTMLElement;
	private complexValueTitle!: HTMLElement;
	private valueContainer!: HTMLElement;
	private treeContainer!: HTMLElement;
	private toDispose: lifecycle.IDisposable[];
	private scrollbar!: DomScrollableElement;

	constructor(
		private editor: ICodeEditor,
		@IDebugService private readonly debugService: IDebugService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService private readonly themeService: IThemeService,
	) {
		this.toDispose = [];

		this._isVisible = false;
		this.showAtPosition = null;
		this.highlightDecorations = [];
	}

	private create(): void {
		this.domNode = $('.debug-hover-widget');
		this.complexValueContainer = dom.append(this.domNode, $('.complex-value'));
		this.complexValueTitle = dom.append(this.complexValueContainer, $('.title'));
		this.treeContainer = dom.append(this.complexValueContainer, $('.debug-hover-tree'));
		this.treeContainer.setAttribute('role', 'tree');
		const dataSource = new DebugHoverDataSource();

		this.tree = <WorkbenchAsyncDataTree<IExpression, IExpression, any>>this.instantiationService.createInstance(WorkbenchAsyncDataTree, 'DebugHover', this.treeContainer, new DebugHoverDelegate(), [this.instantiationService.createInstance(VariablesRenderer)],
			dataSource, {
			accessibilityProvider: new DebugHoverAccessibilityProvider(),
			mouseSupport: false,
			horizontalScrolling: true,
			useShadows: false,
			overrideStyles: {
				listBackground: editorHoverBackground
			}
		});

		this.valueContainer = $('.value');
		this.valueContainer.tabIndex = 0;
		this.valueContainer.setAttribute('role', 'tooltip');
		this.scrollbar = new DomScrollableElement(this.valueContainer, { horizontal: ScrollbarVisibility.Hidden });
		this.domNode.appendChild(this.scrollbar.getDomNode());
		this.toDispose.push(this.scrollbar);

		this.editor.applyFontInfo(this.domNode);

		this.toDispose.push(attachStylerCallback(this.themeService, { editorHoverBackground, editorHoverBorder, editorHoverForeground }, colors => {
			if (colors.editorHoverBackground) {
				this.domNode.style.backgroundColor = colors.editorHoverBackground.toString();
			} else {
				this.domNode.style.backgroundColor = '';
			}
			if (colors.editorHoverBorder) {
				this.domNode.style.border = `1px solid ${colors.editorHoverBorder}`;
			} else {
				this.domNode.style.border = '';
			}
			if (colors.editorHoverForeground) {
				this.domNode.style.color = colors.editorHoverForeground.toString();
			} else {
				this.domNode.style.color = '';
			}
		}));
		this.toDispose.push(this.tree.onDidChangeContentHeight(() => this.layoutTreeAndContainer()));

		this.registerListeners();
		this.editor.addContentWidget(this);
	}

	private registerListeners(): void {
		this.toDispose.push(dom.addStandardDisposableListener(this.domNode, 'keydown', (e: IKeyboardEvent) => {
			if (e.equals(KeyCode.Escape)) {
				this.hide();
			}
		}));
		this.toDispose.push(this.editor.onDidChangeConfiguration((e: ConfigurationChangedEvent) => {
			if (e.hasChanged(EditorOption.fontInfo)) {
				this.editor.applyFontInfo(this.domNode);
			}
		}));
	}

	isHovered(): boolean {
		return this.domNode.matches(':hover');
	}

	isVisible(): boolean {
		return this._isVisible;
	}

	getId(): string {
		return DebugHoverWidget.ID;
	}

	getDomNode(): HTMLElement {
		return this.domNode;
	}

	async showAt(range: Range, focus: boolean): Promise<void> {
		const session = this.debugService.getViewModel().focusedSession;

		if (!session || !this.editor.hasModel()) {
			return Promise.resolve(this.hide());
		}

		const model = this.editor.getModel();
		const pos = range.getStartPosition();

		let rng: IRange | undefined = undefined;
		let matchingExpression: string | undefined;

		if (EvaluatableExpressionProviderRegistry.has(model)) {
			const supports = EvaluatableExpressionProviderRegistry.ordered(model);

			const promises = supports.map(support => {
				return Promise.resolve(support.provideEvaluatableExpression(model, pos, CancellationToken.None)).then(expression => {
					return expression;
				}, err => {
					//onUnexpectedExternalError(err);
					return undefined;
				});
			});

			const results = await Promise.all(promises).then(coalesce);
			if (results.length > 0) {
				matchingExpression = results[0].expression;
				rng = results[0].range;

				if (!matchingExpression) {
					const lineContent = model.getLineContent(pos.lineNumber);
					matchingExpression = lineContent.substring(rng.startColumn - 1, rng.endColumn - 1);
				}
			}

		} else {	// old one-size-fits-all strategy
			const lineContent = model.getLineContent(pos.lineNumber);
			const { start, end } = getExactExpressionStartAndEnd(lineContent, range.startColumn, range.endColumn);

			// use regex to extract the sub-expression #9821
			matchingExpression = lineContent.substring(start - 1, end);
			rng = new Range(pos.lineNumber, start, pos.lineNumber, start + matchingExpression.length);
		}

		if (!matchingExpression) {
			return Promise.resolve(this.hide());
		}

		let expression;
		if (session.capabilities.supportsEvaluateForHovers) {
			expression = new Expression(matchingExpression);
			await expression.evaluate(session, this.debugService.getViewModel().focusedStackFrame, 'hover');
		} else {
			const focusedStackFrame = this.debugService.getViewModel().focusedStackFrame;
			if (focusedStackFrame) {
				expression = await findExpressionInStackFrame(focusedStackFrame, coalesce(matchingExpression.split('.').map(word => word.trim())));
			}
		}

		if (!expression || (expression instanceof Expression && !expression.available)) {
			this.hide();
			return;
		}

		if (rng) {
			this.highlightDecorations = this.editor.deltaDecorations(this.highlightDecorations, [{
				range: rng,
				options: DebugHoverWidget._HOVER_HIGHLIGHT_DECORATION_OPTIONS
			}]);
		}

		return this.doShow(pos, expression, focus);
	}

	private static readonly _HOVER_HIGHLIGHT_DECORATION_OPTIONS = ModelDecorationOptions.register({
		className: 'hoverHighlight'
	});

	private async doShow(position: Position, expression: IExpression, focus: boolean, forceValueHover = false): Promise<void> {
		if (!this.domNode) {
			this.create();
		}

		this.showAtPosition = position;
		this._isVisible = true;

		if (!expression.hasChildren || forceValueHover) {
			this.complexValueContainer.hidden = true;
			this.valueContainer.hidden = false;
			renderExpressionValue(expression, this.valueContainer, {
				showChanged: false,
				colorize: true
			});
			this.valueContainer.title = '';
			this.editor.layoutContentWidget(this);
			this.scrollbar.scanDomNode();
			if (focus) {
				this.editor.render();
				this.valueContainer.focus();
			}

			return Promise.resolve(undefined);
		}

		this.valueContainer.hidden = true;

		await this.tree.setInput(expression);
		this.complexValueTitle.textContent = expression.value;
		this.complexValueTitle.title = expression.value;
		this.layoutTreeAndContainer();
		this.editor.layoutContentWidget(this);
		this.scrollbar.scanDomNode();
		this.tree.scrollTop = 0;
		this.tree.scrollLeft = 0;
		this.complexValueContainer.hidden = false;

		if (focus) {
			this.editor.render();
			this.tree.domFocus();
		}
	}

	private layoutTreeAndContainer(): void {
		const scrollBarHeight = 8;
		const treeHeight = Math.min(MAX_TREE_HEIGHT, this.tree.contentHeight + scrollBarHeight);
		this.treeContainer.style.height = `${treeHeight}px`;
		this.tree.layout(treeHeight, 324);
	}

	hide(): void {
		if (!this._isVisible) {
			return;
		}

		if (dom.isAncestor(document.activeElement, this.domNode)) {
			this.editor.focus();
		}
		this._isVisible = false;
		this.editor.deltaDecorations(this.highlightDecorations, []);
		this.highlightDecorations = [];
		this.editor.layoutContentWidget(this);
	}

	getPosition(): IContentWidgetPosition | null {
		return this._isVisible ? {
			position: this.showAtPosition,
			preference: [
				ContentWidgetPositionPreference.ABOVE,
				ContentWidgetPositionPreference.BELOW
			]
		} : null;
	}

	dispose(): void {
		this.toDispose = lifecycle.dispose(this.toDispose);
	}
}

class DebugHoverAccessibilityProvider implements IListAccessibilityProvider<IExpression> {

	getWidgetAriaLabel(): string {
		return nls.localize('treeAriaLabel', "Debug Hover");
	}

	getAriaLabel(element: IExpression): string {
		return nls.localize('variableAriaLabel', "{0} value {1}, variables, debug", element.name, element.value);
	}
}

class DebugHoverDataSource implements IAsyncDataSource<IExpression, IExpression> {

	hasChildren(element: IExpression): boolean {
		return element.hasChildren;
	}

	getChildren(element: IExpression): Promise<IExpression[]> {
		return element.getChildren();
	}
}

class DebugHoverDelegate implements IListVirtualDelegate<IExpression> {
	getHeight(element: IExpression): number {
		return 18;
	}

	getTemplateId(element: IExpression): string {
		return VariablesRenderer.ID;
	}
}
