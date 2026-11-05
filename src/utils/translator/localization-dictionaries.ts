import traverse, { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';

type AnyPath = NodePath<t.Node | null | undefined>;

function propertyName(node: t.Node): string | null {
    if (t.isIdentifier(node)) return node.name;
    if (t.isStringLiteral(node)) return node.value;
    return null;
}

function isText(node: t.Node): node is t.StringLiteral | t.TemplateLiteral {
    return t.isStringLiteral(node) || t.isTemplateLiteral(node);
}

function isWriteTarget(path: NodePath): boolean {
    let target = path;
    while (target.parentPath?.isObjectPattern() || target.parentPath?.isArrayPattern() ||
        target.parentPath?.isRestElement() || target.parentPath?.isAssignmentPattern() ||
        (target.parentPath?.isObjectProperty() && target.parentPath.parentPath.isObjectPattern())) {
        target = target.parentPath;
    }
    const usage = target.parentPath;
    return (usage?.isAssignmentExpression() && usage.node.left === target.node) ||
        ((usage?.isForOfStatement() || usage?.isForInStatement()) && usage.node.left === target.node) ||
        !!usage?.isUpdateExpression() || !!usage?.isUnaryExpression({ operator: 'delete' });
}

/** 只识别已用于白名单界面调用、并注册为多语言目录英文项的静态字典。 */
export function findLocalizationDictionaries(ast: t.Node, uiFunctions: string[]): Set<t.ObjectExpression> {
    const dictionaries = new Set<t.ObjectExpression>();
    const localizers = new Map<Binding, t.ObjectExpression[]>();
    const stableBindings = new Map<Binding, boolean>();

    const isStableObject = (binding: Binding): boolean => {
        const cached = stableBindings.get(binding);
        if (cached !== undefined) return cached;
        const initializer = binding.path.isVariableDeclarator() ? binding.path.node.init : null;
        const stringTable = t.isObjectExpression(initializer) && initializer.properties.every((property) => (
            t.isObjectProperty(property) && isText(property.value)
        ));
        const stable = binding.constant && binding.referencePaths.every((reference) => {
            const parent = reference.parentPath;
            if (parent?.isObjectProperty() && parent.node.value === reference.node) {
                return !parent.node.computed && /^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(propertyName(parent.node.key) || '');
            }
            if ((!parent?.isMemberExpression() && !parent?.isOptionalMemberExpression()) || parent.node.object !== reference.node) return false;
            let access: NodePath = parent;
            let depth = 1;
            while ((access.parentPath?.isMemberExpression() || access.parentPath?.isOptionalMemberExpression()) &&
                access.parentPath.node.object === access.node) {
                access = access.parentPath;
                depth++;
            }
            const usage = access.parentPath;
            if (isWriteTarget(access)) return false;
            if (!stringTable && depth === 1) {
                // 保留按运行时语言选择目录的赋值；静态子目录外传或形成别名则无法确认稳定。
                return access.isMemberExpression() && access.node.computed && !t.isStringLiteral(access.node.property) &&
                    !!usage?.isAssignmentExpression() && usage.node.right === access.node && t.isIdentifier(usage.node.left);
            }
            return !(usage?.isCallExpression() && usage.node.callee === access.node);
        });
        stableBindings.set(binding, stable);
        return stable;
    };

    const staticObject = (value: AnyPath, seen = new Set<Binding>()): NodePath<t.ObjectExpression> | null => {
        if (value.isObjectExpression()) return value;
        if (value.isIdentifier()) {
            const binding = value.scope.getBinding(value.node.name);
            if (!binding || !isStableObject(binding) || seen.has(binding) || !binding.path.isVariableDeclarator()) return null;
            seen.add(binding);
            return staticObject(binding.path.get('init'), seen);
        }
        if (value.isMemberExpression() && (!value.node.computed || t.isStringLiteral(value.node.property))) {
            const object = staticObject(value.get('object'), seen);
            const key = propertyName(value.node.property);
            if (!object || !key) return null;
            const property = object.get('properties').find((item) => (
                item.isObjectProperty() && !item.node.computed && propertyName(item.node.key) === key
            ));
            if (property?.isObjectProperty()) return staticObject(property.get('value'), seen);
        }
        return null;
    };

    const isEnglishEntry = (property: NodePath): boolean => {
        if (!property.isObjectProperty() || property.node.computed || propertyName(property.node.key) !== 'en') return false;
        const catalog = property.parentPath;
        if (!catalog.isObjectExpression() || catalog.node.properties.length < 2) return false;
        if (!catalog.parentPath.isVariableDeclarator() || !t.isIdentifier(catalog.parentPath.node.id)) return false;
        const binding = catalog.parentPath.scope.getBinding(catalog.parentPath.node.id.name);
        if (!binding || !isStableObject(binding)) return false;
        return catalog.get('properties').every((entry) => (
            entry.isObjectProperty() && !entry.node.computed &&
            /^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(propertyName(entry.node.key) || '') &&
            staticObject(entry.get('value')) !== null
        ));
    };

    const isEnglishDictionary = (dictionary: NodePath<t.ObjectExpression>): boolean => {
        if (!dictionary.node.properties.length || !dictionary.node.properties.every((property) => (
            t.isObjectProperty(property) && !property.computed && propertyName(property.key) && isText(property.value)
        ))) return false;
        if (isEnglishEntry(dictionary.parentPath)) return true;
        const declaration = dictionary.parentPath;
        if (!declaration.isVariableDeclarator() || !t.isIdentifier(declaration.node.id)) return false;
        const binding = declaration.scope.getBinding(declaration.node.id.name);
        return !!binding?.constant && binding.referencePaths.some((reference) => (
            reference.parentPath?.isObjectProperty() && reference.parentPath.node.value === reference.node &&
            isEnglishEntry(reference.parentPath)
        ));
    };

    const identifyLocalizer = (binding: Binding): t.ObjectExpression[] => {
        if (!binding.constant) return [];
        const declaration = binding.path;
        const candidate = declaration.isVariableDeclarator() ? declaration.get('init') : declaration;
        if (!candidate.isFunctionDeclaration() && !candidate.isFunctionExpression() && !candidate.isArrowFunctionExpression()) return [];
        const fn = candidate as NodePath<t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression>;
        const parameter = fn.node.params[0];
        if (!t.isIdentifier(parameter)) return [];
        const parameterBinding = fn.scope.getBinding(parameter.name);
        const isParameter = (value: AnyPath) => (
            value.isIdentifier() && value.scope.getBinding(value.node.name) === parameterBinding
        );
        const lookup = (value: AnyPath): t.ObjectExpression[] => {
            if (value.isLogicalExpression() && ['||', '??'].includes(value.node.operator)) {
                const left = value.get('left');
                if (!left.isMemberExpression() && !left.isOptionalMemberExpression()) return [];
                const fallback = left as NodePath<t.MemberExpression | t.OptionalMemberExpression>;
                if (!fallback.node.computed || !isParameter(fallback.get('property'))) return [];
                return [...lookup(value.get('left')), ...lookup(value.get('right'))];
            }
            if (!value.isMemberExpression() || !value.node.computed || !isParameter(value.get('property'))) return [];
            const dictionary = staticObject(value.get('object'));
            return dictionary && isEnglishDictionary(dictionary) ? [dictionary.node] : [];
        };
        const body = fn.get('body');
        if (!body.isBlockStatement()) return lookup(body);
        const returns: NodePath<t.ReturnStatement>[] = [];
        fn.traverse({
            Function: (path) => path.skip(),
            ReturnStatement: (path) => { returns.push(path); }
        });
        if (returns.length !== 1 || body.node.body[body.node.body.length - 1] !== returns[0].node) return [];
        const result = returns[0].get('argument');
        if (!isParameter(result)) return lookup(result);

        // 兼容 key = locale[key] || english[key]; key = key.replace(...); return key。
        let assignment: NodePath<t.AssignmentExpression> | null = null;
        let resultDictionaries: t.ObjectExpression[] = [];
        for (const write of parameterBinding?.constantViolations || []) {
            if (!write.isAssignmentExpression({ operator: '=' })) return [];
            const right = write.get('right');
            const found = lookup(right);
            if (found.length) {
                if (assignment || !write.parentPath.isExpressionStatement() || write.parentPath.parentPath.node !== body.node) return [];
                assignment = write;
                resultDictionaries = found;
            } else if (!right.isCallExpression() || !t.isMemberExpression(right.node.callee) ||
                right.node.callee.computed || !t.isIdentifier(right.node.callee.property) ||
                !['replace', 'replaceAll'].includes(right.node.callee.property.name) ||
                !isParameter(right.get('callee').get('object'))) return [];
        }
        if (!assignment || (parameterBinding?.constantViolations || []).some((write) => (
            write !== assignment && (write.node.start ?? 0) < (assignment.node.start ?? 0)
        ))) return [];
        return resultDictionaries;
    };

    const markCall = (call: AnyPath) => {
        if (!call.isCallExpression() || !t.isIdentifier(call.node.callee)) return;
        const binding = call.scope.getBinding(call.node.callee.name);
        if (!binding) return;
        if (!localizers.has(binding)) localizers.set(binding, identifyLocalizer(binding));
        for (const dictionary of localizers.get(binding) || []) dictionaries.add(dictionary);
    };
    const visitUi = (path: NodePath<t.CallExpression | t.NewExpression>) => {
        const callee = path.node.callee;
        const name = t.isMemberExpression(callee) ? propertyName(callee.property) : propertyName(callee);
        if (!name || !uiFunctions.includes(name)) return;
        for (const argument of path.get('arguments')) {
            markCall(argument);
            if (argument.isObjectExpression()) {
                for (const property of argument.get('properties')) {
                    if (property.isObjectProperty()) markCall(property.get('value'));
                }
            }
        }
    };
    traverse(ast, { CallExpression: visitUi, NewExpression: visitUi });
    return dictionaries;
}
