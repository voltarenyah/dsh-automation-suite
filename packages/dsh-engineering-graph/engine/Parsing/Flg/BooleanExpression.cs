// A tiny boolean expression parser/evaluator, used ONLY to cross-check the rung reducer against
// the statement translator (docs/lad-understanding-plan.md phase 3).
//
// It is deliberately strict: anything it does not understand makes the parse fail, and the caller
// skips that network and counts it. A lenient parser would silently "agree" with a wrong rung by
// ignoring the part it could not read, which is the one failure mode this check exists to prevent.
using System;
using System.Collections.Generic;
using System.Linq;

namespace EngineeringGraph.Engine;

/// <summary>Parsed boolean expression: identifiers, NOT / AND / OR and parentheses.</summary>
internal sealed class BooleanExpression
{
    private readonly Func<Func<string, bool>, bool> _evaluate;

    private BooleanExpression(Func<Func<string, bool>, bool> evaluate, IReadOnlyCollection<string> variables)
    {
        _evaluate = evaluate;
        Variables = variables;
    }

    public IReadOnlyCollection<string> Variables { get; }

    public bool Evaluate(Func<string, bool> values) => _evaluate(values);

    /// <summary>Combines two expressions with OR; used to fold several rung paths into one condition.</summary>
    public static BooleanExpression Or(IReadOnlyList<BooleanExpression> terms)
    {
        if (terms.Count == 0)
        {
            return new BooleanExpression(_ => true, Array.Empty<string>());
        }

        var variables = new HashSet<string>(StringComparer.Ordinal);
        foreach (BooleanExpression term in terms)
        {
            variables.UnionWith(term.Variables);
        }

        BooleanExpression[] captured = terms.ToArray();
        return new BooleanExpression(values => captured.Any(term => term.Evaluate(values)), variables);
    }

    public static BooleanExpression And(IReadOnlyList<BooleanExpression> terms)
    {
        if (terms.Count == 0)
        {
            return new BooleanExpression(_ => true, Array.Empty<string>());
        }

        var variables = new HashSet<string>(StringComparer.Ordinal);
        foreach (BooleanExpression term in terms)
        {
            variables.UnionWith(term.Variables);
        }

        BooleanExpression[] captured = terms.ToArray();
        return new BooleanExpression(values => captured.All(term => term.Evaluate(values)), variables);
    }

    public static BooleanExpression Not(BooleanExpression operand) =>
        new(values => !operand.Evaluate(values), operand.Variables);

    public static BooleanExpression Variable(string name) =>
        new(values => values(name), new[] { name });

    public static BooleanExpression Constant(bool value) =>
        new(_ => value, Array.Empty<string>());

    /// <summary>
    /// One rung step as a term. A step whose operand is the literal <c>TRUE</c>/<c>FALSE</c> is a
    /// constant, not a variable: real networks use those as "always"/placeholder conditions, and
    /// treating them as free variables made equivalent networks disagree with the translator.
    /// </summary>
    public static BooleanExpression OperandTerm(string operand, bool negated)
    {
        BooleanExpression term =
            string.Equals(operand, "TRUE", StringComparison.OrdinalIgnoreCase) ? Constant(true) :
            string.Equals(operand, "FALSE", StringComparison.OrdinalIgnoreCase) ? Constant(false) :
            Variable(operand);

        return negated ? Not(term) : term;
    }

    /// <summary>Parses "A AND NOT B OR (C AND D)". Returns false on anything unexpected.</summary>
    public static bool TryParse(string text, out BooleanExpression? expression)
    {
        expression = null;
        if (!TryTokenize(text, out List<Token> tokens))
        {
            return false;
        }

        var position = 0;
        BooleanExpression? or = ParseOr(tokens, ref position);
        if (or == null || position != tokens.Count)
        {
            return false;
        }

        expression = or;
        return true;
    }

    private static BooleanExpression? ParseOr(List<Token> tokens, ref int position)
    {
        BooleanExpression? left = ParseAnd(tokens, ref position);
        if (left == null)
        {
            return null;
        }

        var terms = new List<BooleanExpression> { left };
        while (position < tokens.Count && tokens[position].Kind == TokenKind.Or)
        {
            position++;
            BooleanExpression? right = ParseAnd(tokens, ref position);
            if (right == null)
            {
                return null;
            }

            terms.Add(right);
        }

        return terms.Count == 1 ? terms[0] : Or(terms);
    }

    private static BooleanExpression? ParseAnd(List<Token> tokens, ref int position)
    {
        BooleanExpression? left = ParseUnary(tokens, ref position);
        if (left == null)
        {
            return null;
        }

        var terms = new List<BooleanExpression> { left };
        while (position < tokens.Count && tokens[position].Kind == TokenKind.And)
        {
            position++;
            BooleanExpression? right = ParseUnary(tokens, ref position);
            if (right == null)
            {
                return null;
            }

            terms.Add(right);
        }

        return terms.Count == 1 ? terms[0] : And(terms);
    }

    private static BooleanExpression? ParseUnary(List<Token> tokens, ref int position)
    {
        if (position >= tokens.Count)
        {
            return null;
        }

        Token token = tokens[position];
        if (token.Kind == TokenKind.Not)
        {
            position++;
            BooleanExpression? operand = ParseUnary(tokens, ref position);
            return operand == null ? null : Not(operand);
        }

        if (token.Kind == TokenKind.LeftParen)
        {
            position++;
            BooleanExpression? inner = ParseOr(tokens, ref position);
            if (inner == null || position >= tokens.Count || tokens[position].Kind != TokenKind.RightParen)
            {
                return null;
            }

            position++;
            return inner;
        }

        if (token.Kind == TokenKind.Identifier)
        {
            position++;
            return Variable(token.Text);
        }

        if (token.Kind == TokenKind.Literal)
        {
            position++;
            return Constant(string.Equals(token.Text, "TRUE", StringComparison.OrdinalIgnoreCase));
        }

        return null;
    }

    private enum TokenKind
    {
        Identifier,
        Literal,
        Not,
        And,
        Or,
        LeftParen,
        RightParen
    }

    private readonly record struct Token(TokenKind Kind, string Text);

    private static bool TryTokenize(string text, out List<Token> tokens)
    {
        tokens = new List<Token>();
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        var position = 0;
        while (position < text.Length)
        {
            char current = text[position];
            if (char.IsWhiteSpace(current))
            {
                position++;
                continue;
            }

            if (current == '(')
            {
                tokens.Add(new Token(TokenKind.LeftParen, "("));
                position++;
                continue;
            }

            if (current == ')')
            {
                tokens.Add(new Token(TokenKind.RightParen, ")"));
                position++;
                continue;
            }

            if (current == '"')
            {
                int close = text.IndexOf('"', position + 1);
                if (close < 0)
                {
                    return false;
                }

                tokens.Add(new Token(TokenKind.Identifier, text.Substring(position, close - position + 1)));
                position = close + 1;
                continue;
            }

            if (!IsIdentifierChar(current))
            {
                return false;
            }

            int start = position;
            while (position < text.Length && IsIdentifierChar(text[position]))
            {
                position++;
            }

            string word = text.Substring(start, position - start);
            if (string.Equals(word, "NOT", StringComparison.OrdinalIgnoreCase))
            {
                tokens.Add(new Token(TokenKind.Not, word));
            }
            else if (string.Equals(word, "AND", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(word, "&", StringComparison.Ordinal))
            {
                tokens.Add(new Token(TokenKind.And, word));
            }
            else if (string.Equals(word, "OR", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(word, "|", StringComparison.Ordinal))
            {
                tokens.Add(new Token(TokenKind.Or, word));
            }
            else if (string.Equals(word, "TRUE", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(word, "FALSE", StringComparison.OrdinalIgnoreCase))
            {
                tokens.Add(new Token(TokenKind.Literal, word));
            }
            else
            {
                tokens.Add(new Token(TokenKind.Identifier, word));
            }
        }

        return tokens.Count > 0;
    }

    /// <summary>
    /// Characters an operand may contain. Deliberately narrow: an expression using anything else is
    /// reported as unparseable so the caller skips the network instead of half-evaluating it.
    /// </summary>
    private static bool IsIdentifierChar(char value) =>
        char.IsLetterOrDigit(value) ||
        value == '_' || value == '.' || value == '%' || value == '#' ||
        value == '[' || value == ']' || value == '-' || value == '&' || value == '|';
}
