// tslint:disable max-classes-per-file ordered-imports object-literal-sort-keys
import {
    DocumentNode,
    GraphQLSchema,
    IntrospectionQuery,
    buildClientSchema,
    parse,
    buildSchema,
    validate,
} from "graphql";
import { RuleFailure, Rules, RuleWalker, IOptions } from "tslint";
import * as ts from "typescript";
import fs = require("fs");
import path = require("path");

const relayRuleNames = [
    "UniqueOperationNames",
    "LoneAnonymousOperation",
    "KnownTypeNames",
    "FragmentsOnCompositeTypes",
    "VariablesAreInputTypes",
    "FieldsOnCorrectType",
    "UniqueFragmentNames",
    // "KnownFragmentNames", -> any interpolation
    // "NoUnusedFragments", -> any standalone fragment
    "PossibleFragmentSpreads",
    "NoFragmentCycles",
    "UniqueVariableNames",
    "NoUnusedVariables",
    "KnownArgumentNames",
    "UniqueArgumentNames",
    "ValuesOfCorrectType",
    "VariablesInAllowedPosition",
    "OverlappingFieldsCanBeMerged",
    "UniqueInputFieldNames",
];
const otherValidationRuleNames = [
    "ScalarLeafs",
    "ProvidedRequiredArguments",
    "KnownDirectives",
    "NoUndefinedVariables",
];
const graphQLValidationRuleNames = [...relayRuleNames, ...otherValidationRuleNames];

const graphQLValidationRules = graphQLValidationRuleNames.map((ruleName) => {
    return require(`graphql/validation/rules/${ruleName}`)[ruleName];
});

const relayGraphQLValidationRules = relayRuleNames.map((ruleName) => {
    return require(`graphql/validation/rules/${ruleName}`)[ruleName];
});
export class Rule extends Rules.AbstractRule {
    public static FAILURE_STRING = "import statement forbidden";

    public apply(sourceFile: ts.SourceFile): RuleFailure[] {
        return this.applyWithWalker(new GraphQLWalker(sourceFile, this.getOptions()));
    }
}

class GraphQLWalker extends RuleWalker {
    protected tagRules: IParseOptions[] = [];
    constructor(sourceFile: ts.SourceFile, options: IOptions) {
        super(sourceFile, options);
        if (options.ruleArguments) {
            options.ruleArguments.map((optionGroup: IOptionGroup) => {
                const {schema, env, tagName} = this.parseOptions(optionGroup);
                const realEnv: Env = typeof (env) === "undefined" ? "lokka" : env;
                this.tagRules.push({ schema, env: realEnv, tagName });
            });
        }
    }
    protected visitNode(node: ts.Node) {
        if (node.kind === ts.SyntaxKind.TaggedTemplateExpression && node.getChildren().length > 1) {
            const temp = (node as ts.TaggedTemplateExpression);
            this.tagRules.map((rule) => {
                if (templateExpressionMatchesTag(rule.tagName, node)) {
                    let query: string | null = null;
                    switch (temp.template.kind) {
                        case ts.SyntaxKind.FirstTemplateToken:
                            query = temp.template.getText();
                            break;
                        case ts.SyntaxKind.TemplateExpression:
                            const template = (temp.template as ts.TemplateExpression);
                            let currentLiteral = template.head.getText();
                            currentLiteral = currentLiteral.substr(0, currentLiteral.length - 2).replace(/\.+$/gi, "");
                            let text = currentLiteral;
                            template.templateSpans.map((span) => {
                                text += replaceExpression(span.expression.getText(), currentLiteral, rule.env);
                                currentLiteral = span.literal.getText();
                                currentLiteral = currentLiteral.substr(2, currentLiteral.length - 4)
                                    .replace(/\.+$/gi, "");
                                text += currentLiteral;
                            });
                            query = text + "}`";
                            break;
                    }
                    if (query !== null) {
                        this.handleTemplate(node, query.substr(1, query.length - 2), rule.schema, rule.env);
                    }
                }
            });
        }
        super.visitNode(node);
    }
    protected handleTemplate(node: ts.Node, text: string, schema: GraphQLSchema, env?: Env) {
        if ((env === "lokka" || env === "relay") && /fragment\s+on/.test(text)) {
            text = text.replace("fragment", "fragment _");
        }
        let ast: DocumentNode;
        try {
            ast = parse(text);
        } catch (error) {
            this.reportFailure(node, "GraphQL invalid syntax: " + error.message.split("\n")[0]);
            return;
        }
        const rules = (env === "relay" ? relayGraphQLValidationRules : graphQLValidationRules);
        const validationErrors = schema ? validate(schema, ast, rules) : [];
        if (validationErrors && validationErrors.length > 0) {
            this.reportFailure(node, "GraphQL validation error: " + validationErrors[0].message);
        }
    }
    protected parseOptions(optionGroup: IOptionGroup): IParseOptions {
        const {
            schemaJson, // Schema via JSON object
            schemaJsonFilepath, // Or Schema via absolute filepath
            schemaFilepath, // Or Schema graphql file
            env,
            tagName: tagNameOption,
        } = optionGroup;

        // Validate and unpack schema
        let schema: GraphQLSchema;
        if (schemaFilepath) {
            const realSchemaFilepath = path.resolve(schemaFilepath);
            schema = initSchemaFromGraphqlFile(realSchemaFilepath);
        } else if (schemaJson) {
            schema = initSchema(schemaJson);
        } else if (schemaJsonFilepath) {
            const realSchemaJsonFilepath = path.resolve(schemaJsonFilepath);
            schema = initSchemaFromFile(realSchemaJsonFilepath);
        } else {
            throw new Error("Must pass in `schemaJson` option with schema object "
                + "or `schemaJsonFilepath` with absolute path to the json file.");
        }

        // Validate env
        if (env && env !== "lokka" && env !== "relay" && env !== "apollo") {
            throw new Error("Invalid option for env, only `apollo`, `lokka`, and `relay` supported.");
        }

        // Validate tagName and set default
        let tagName: string;
        if (tagNameOption) {
            tagName = tagNameOption;
        } else if (env === "relay") {
            tagName = "Relay.QL";
        } else {
            tagName = "gql";
        }
        return { schema, env, tagName };
    }
    private reportFailure(node: ts.Node, error: string) {
        this.addFailure(this.createFailure(node.getStart(), node.getWidth(), "" + error));
    }
}

export interface IOptionGroup {
    schemaJson?: any;
    schemaJsonFilepath?: string;
    schemaFilepath?: string;
    env?: Env;
    tagName?: string;
}
export interface IGraphQLSchemaJSON {
    data: IntrospectionQuery;
}
interface IParseOptions {
    schema: GraphQLSchema;
    tagName: string;
    env?: Env;
}
type Env = "lokka" | "relay" | "apollo";

function initSchema(json: IGraphQLSchemaJSON & IntrospectionQuery) {
    const unpackedSchemaJson = json.data ? json.data : json;
    if (!unpackedSchemaJson.__schema) {
        throw new Error("Please pass a valid GraphQL introspection query result.");
    }
    return buildClientSchema(unpackedSchemaJson);
}

function initSchemaFromFile(jsonFile: string) {
    return initSchema(JSON.parse(fs.readFileSync(jsonFile, "utf8")));
}
function initSchemaFromGraphqlFile(graphqlFile: string) {
    return buildSchema(fs.readFileSync(graphqlFile, "utf8"));
}
function templateExpressionMatchesTag(tagName: string, node: ts.Node) {
    const tagNameSegments = tagName.split(".").length;
    if (tagNameSegments === 1) {
        return node.getChildren()[0].kind === ts.SyntaxKind.Identifier && node.getChildren()[0].getText() === tagName;
    } else if (tagNameSegments === 2) {
        return node.getChildren()[0].kind === ts.SyntaxKind.PropertyAccessExpression
            && tagName ===
            (node.getChildren()[0] as ts.PropertyAccessExpression).expression.getText() + "." +
            (node.getChildren()[0] as ts.PropertyAccessExpression).name.getText();
    } else {
        // We don't currently support 3 segments so ignore
        return false;
    }
}
function replaceExpression(fragment: string, chunk: string, env?: Env) {
    const nameLength = fragment.length;
    if (env === "relay") {
        // The chunk before this one had a colon at the end, so this
        // is a variable

        // Add 2 for brackets in the interpolation
        if (/:\s*$/.test(chunk)) {
            return "$" + strWithLen(nameLength + 2);
        } else {
            return "..." + strWithLen(nameLength);
        }
        //
    } else if (env === "lokka" && /\.\.\.\s*$/.test(chunk)) {
        // This is Lokka-style fragment interpolation where you actually type the '...' yourself
        return strWithLen(nameLength + 3);
    } else {
        return fragment;
        // throw new Error("Invalid interpolation");
    }
}
function strWithLen(len: number) {
    // from
    // http://stackoverflow.com/questions/14343844/create-a-string-of-variable-length-filled-with-a-repeated-character
    return new Array(len + 1).join("x");
}
