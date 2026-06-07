import assert from "node:assert/strict";

function indent(lines, how_much)
{
    return lines.map(line => " ".repeat(how_much) + line);
}

export function print_syntax_tree(statements)
{
    let code = [];

    for(let statement of statements)
    {
        if(typeof statement === "string")
        {
            code.push(statement);
        }
        else if(statement.type === "switch")
        {
            assert(statement.condition);

            const cases = [];

            for(let case_ of statement.cases)
            {
                assert(case_.conditions.length >= 1);

                cases.push(case_.conditions.join(" | ") + " => {");
                cases.push.apply(cases, indent(print_syntax_tree(case_.body), 4));
                cases.push(`},`);
            }

            if(statement.default_case)
            {
                const varname = statement.default_case.varname || "_";
                cases.push(`${varname} => {`);
                cases.push.apply(cases, indent(print_syntax_tree(statement.default_case.body), 4));
                cases.push(`}`);
            }

            code.push(`match ${statement.condition} {`);
            code.push.apply(code, indent(cases, 4));
            code.push(`}`);
        }
        else if(statement.type === "if-else")
        {
            assert(statement.if_blocks.length >= 1);

            let first_if_block = statement.if_blocks[0];

            code.push(`if ${first_if_block.condition} {`);
            code.push.apply(code, indent(print_syntax_tree(first_if_block.body), 4));
            code.push(`}`);

            for(let i = 1; i < statement.if_blocks.length; i++)
            {
                let if_block = statement.if_blocks[i];

                code.push(`else if ${if_block.condition} {`);
                code.push.apply(code, indent(print_syntax_tree(if_block.body), 4));
                code.push(`}`);
            }

            if(statement.else_block)
            {
                code.push(`else {`);
                code.push.apply(code, indent(print_syntax_tree(statement.else_block.body), 4));
                code.push(`}`);
            }
        }
        else
        {
            assert(false, "Unexpected type: " + statement.type, "In:", statement);
        }
    }

    return code;
}
