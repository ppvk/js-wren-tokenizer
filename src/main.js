
// The maximum depth that interpolation can nest. For example, this string has
// three levels:
//
//      "outside %(one + "%(two + "%(three)")")"
let MAX_INTERPOLATION_NESTING = 8;


class Keyword {
    constructor(identifier, length, tokenType) {
        this.identifier = identifier;
        this.length = length;
        this.tokenType = tokenType;
    }
}

// The table of reserved words and their associated token types.
let keywords = [
    new Keyword('break',     5, 'TOKEN_BREAK'),
    new Keyword('class',     5, 'TOKEN_CLASS'),
    new Keyword('construct', 9, 'TOKEN_CONSTRUCT'),
    new Keyword('else',      4, 'TOKEN_ELSE'),
    new Keyword('false',     5, 'TOKEN_FALSE'),
    new Keyword('for',       3, 'TOKEN_FOR'),
    new Keyword('foreign',   7, 'TOKEN_FOREIGN'),
    new Keyword('if',        2, 'TOKEN_IF'),
    new Keyword('import',    6, 'TOKEN_IMPORT'),
    new Keyword('in',        2, 'TOKEN_IN'),
    new Keyword('is',        2, 'TOKEN_IS'),
    new Keyword('null',      4, 'TOKEN_NULL'),
    new Keyword('return',    6, 'TOKEN_RETURN'),
    new Keyword('static',    6, 'TOKEN_STATIC'),
    new Keyword('super',     5, 'TOKEN_SUPER'),
    new Keyword('this',      4, 'TOKEN_THIS'),
    new Keyword('true',      4, 'TOKEN_TRUE'),
    new Keyword('var',       3, 'TOKEN_VAR'),
    new Keyword('while',     5, 'TOKEN_WHILE'),
    new Keyword(null,        0, 'TOKEN_EOF') // Sentinel to mark the end of the array.
];

export class Parser {
    constructor(source) {
        // The source code being parsed.
        this.source = source;

        // The beginning of the currently-being-lexed token in [source].
        this.tokenStart = 0;

        // The current character being lexed in [source].
        this.currentChar = 0;

        // The 1-based line number of [currentChar].
        this.currentLine = 0;

        // The most recently lexed token.
        this.current = {
            type: undefined,
            length: 0,
            line: 0,
            value: undefined
        };

        // The most recently consumed/advanced token.
        this.previous = {
            type: undefined,
            length: 0,
            line: 0,
            value: undefined
        };

        // Tracks the lexing state when tokenizing interpolated strings.
        //
        // Interpolated strings make the lexer not strictly regular: we don't know
        // whether a ")" should be treated as a RIGHT_PAREN token or as ending an
        // interpolated expression unless we know whether we are inside a string
        // interpolation and how many unmatched "(" there are. This is particularly
        // complex because interpolation can nest:
        //
        //     " %( " %( inner ) " ) "
        //
        // This tracks that state. The parser maintains a stack of ints, one for each
        // level of current interpolation nesting. Each value is the number of
        // unmatched "(" that are waiting to be closed.
        this.parens = Array(MAX_INTERPOLATION_NESTING);
        this.numParens = 0;

        // If subsequent newline tokens should be discarded.
        this.skipNewlines;

        // Whether compile errors should be printed to stderr or discarded.
        this.printErrors;

        // If a syntax or compile error has occurred.
        this.hasError;


        this.tokens = [];

        for (let i = 0; i < 85; i++) {
            this.nextToken();
        }

    }

    // Returns true if [c] is a valid (non-initial) identifier character.
    isName(c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
    }

    // Returns true if [c] is a digit.
    isDigit(c) {
        return c >= '0' && c <= '9';
    }

    // Returns the current character the parser is sitting on.
    peekChar() {
        return this.source[this.currentChar];
    }

    // Returns the character after the current character.
    peekNextChar() {
        return this.source[this.currentChar + 1];
    }

    // Advances the parser forward one character.
    nextChar() {
        let c = this.peekChar();
        this.currentChar++;
        if (c == '\n') this.currentLine++;
        return c;
    }

    // If the current character is [c], consumes it and returns `true`.
    matchChar(c) {
        if (this.peekChar() != c) return false;
        this.nextChar();
        return true;
    }

    // Sets the parser's current token to the given [type] and current character
    // range.
    makeToken(type) {
        this.current.type = type;
        this.current.start = this.tokenStart;
        this.current.length = this.currentChar - this.tokenStart;
        this.current.line = this.currentLine;

        // Make line tokens appear on the line containing the "\n".
        if (type == 'TOKEN_LINE') this.current.line--;

        this.tokens.push({
            type: type,
            value: this.source.substr(this.current.start, this.current.length),
            line: this.current.line

        });
    }

    // If the current character is [c], then consumes it and makes a token of type
    // [two]. Otherwise makes a token of type [one].
    twoCharToken(c, two, one) {
        this.makeToken(this.matchChar(c) ? two : one);
    }

    // Skips the rest of the current line.
    skipLineComment() {
        while (this.peekChar() != '\n' && this.peekChar() != '\0') {
            this.nextChar();
        }
    }

    // Skips the rest of a block comment.
    skipBlockComment() {
        let nesting = 1;
        while (nesting > 0) {
            if (this.peekChar() == '\0') {
                this.lexError('Unterminated block comment.');
                return;
            }

            if (this.peekChar() == '/' && this.peekNextChar() == '*') {
                this.nextChar();
                this.nextChar();
                nesting++;
                continue;
            }

            if (this.peekChar() == '*' && this.peekNextChar() == '/') {
                this.nextChar();
                this.nextChar();
                nesting--;
                continue;
            }

            // Regular comment character.
            this.nextChar();
        }
    }

    // Reads the next character, which should be a hex digit (0-9, a-f, or A-F) and
    // returns its numeric value. If the character isn't a hex digit, returns -1.
    readHexDigit() {
        let c = this.nextChar();
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;

        // Don't consume it if it isn't expected. Keeps us from reading past the end
        // of an unterminated string.
        this.currentChar--;
        return -1;
    }

    // Parses the numeric value of the current token.
    makeNumber(isHex) {

        if (isHex) {
            this.current.value = parseInt(this.tokenStart, 16);
        } else {
            this.current.value = parseFloat(this.tokenStart);
        }

        this.makeToken('TOKEN_NUMBER');
    }

    // Finishes lexing a hexadecimal number literal.
    readHexNumber() {
        // Skip past the `x` used to denote a hexadecimal literal.
        this.nextChar();

        // Iterate over all the valid hexadecimal digits found.
        while (this.readHexDigit() != -1) continue;

        this.makeNumber(true);
    }

    // Finishes lexing a number literal.
    readNumber() {
        while (this.isDigit(this.peekChar())) this.nextChar();

        // See if it has a floating point. Make sure there is a digit after the "."
        // so we don't get confused by method calls on number literals.
        if (this.peekChar() == '.' && this.isDigit(this.peekNextChar())) {
            this.nextChar();
            while (this.isDigit(this.peekChar())) this.nextChar();
        }

        // See if the number is in scientific notation.
        if (this.matchChar('e') || this.matchChar('E')) {
        // Allow a negative exponent.
            this.matchChar('-');

            if (!this.isDigit(this.peekChar())) {
                this.lexError('Unterminated scientific notation.');
            }

            while (this.isDigit(this.peekChar())) this.nextChar();
        }

        this.makeNumber(false);
    }

    // Finishes lexing an identifier. Handles reserved words.
    readName(type) {
        while (this.isName(this.peekChar()) || this.isDigit(this.peekChar())) {
            this.nextChar();
        }

        // Update the type if it's a keyword.
        let length = this.currentChar - this.tokenStart;
        for (let i = 0; i < keywords.length; i++) {
            let name = this.source.substr(this.tokenStart, length);
            if (name.length == keywords[i].length &&
                name == keywords[i].identifier) {
                type = keywords[i].tokenType;
                break;
            }
        }

        this.makeToken(type);
    }

    // Reads [digits] hex digits in a string literal and returns their number value.
    readHexEscape(digits, description) {
        let value = 0;
        for (let i = 0; i < digits; i++) {
            if (this.peekChar() == '"' || this.peekChar() == '\0') {
                this.lexError('Incomplete ' + description + ' escape sequence.');

                // Don't consume it if it isn't expected. Keeps us from reading past the
                // end of an unterminated string.
                this.currentChar--;
                break;
            }

            let digit = this.readHexDigit();
            if (digit == -1) {
                this.lexError('Invalid ' + description + ' escape sequence.');
                break;
            }

            value = (value * 16) | digit;
        }

        return value;
    }

    /* TODO
    // Reads a hex digit Unicode escape sequence in a string literal.
    readUnicodeEscape(string, length) {
        let value = this.readHexEscape(length, 'Unicode');

        // Grow the buffer enough for the encoded result.
        let numBytes = wrenUtf8EncodeNumBytes(value);
        if (numBytes != 0) {
            wrenByteBufferFill(this.vm, string, 0, numBytes);
            wrenUtf8Encode(value, string.data + string.count - numBytes);
        }
    }
    */

    // TODO
    // Finishes lexing a string literal.
    readString() {
        //let string = '';
        let type = 'TOKEN_STRING';

        for (;;) {
            let c = this.nextChar();
            if (c == '"') break;

            if (c == '\0') {
                this.lexError('Unterminated string.');

                // Don't consume it if it isn't expected. Keeps us from reading past the
                // end of an unterminated string.
                this.currentChar--;
                break;
            }

            if (c == '%') {
                if (this.numParens < MAX_INTERPOLATION_NESTING) {
                    // TODO: Allow format string.
                    if (this.nextChar() != '(') this.lexError('Expect \'(\' after \'%%\'.');

                    this.parens[this.numParens++] = 1;
                    type = 'TOKEN_INTERPOLATION';
                    break;
                }

                this.lexError('Interpolation may only nest ' +
            MAX_INTERPOLATION_NESTING + ' levels deep.');
            }

            if (c == '\\') {
                console.log(123);
                switch (this.nextChar()) {
                //case '"':  wrenByteBufferWrite(this.vm, string, '"'); break;
                //case '\\': wrenByteBufferWrite(this.vm, string, '\\'); break;
                //case '%':  wrenByteBufferWrite(this.vm, string, '%'); break;
                //case '0':  wrenByteBufferWrite(this.vm, string, '\0'); break;
                //case 'a':  wrenByteBufferWrite(this.vm, string, '\a'); break;
                //case 'b':  wrenByteBufferWrite(this.vm, string, '\b'); break;
                //case 'f':  wrenByteBufferWrite(this.vm, string, '\f'); break;
                //case 'n':  wrenByteBufferWrite(this.vm, string, '\n'); break;
                //case 'r':  wrenByteBufferWrite(this.vm, string, '\r'); break;
                case 't':  this.current.value =  '\t'; break;
                //case 'u':  this.readUnicodeEscape(string, 4); break;
                //case 'U':  this.readUnicodeEscape(string, 8); break;
                case 'v':  this.current.value = '\v'; break;
                case 'x':
                    this.current.value = this.readHexEscape(2, 'byte');
                    break;

                default:
                    this.lexError('Invalid escape character \'' +
                (this.currentChar - 1) + '\'.');
                    break;
                }
            }
            //else
            //{
            //    string += c;
            //}
        }

        this.makeToken(type);
    }

    // Lex the next token and store it in [parser.current].
    nextToken() {
        this.previous = this.current;

        // If we are out of tokens, don't try to tokenize any more. We *do* still
        // copy the TOKEN_EOF to previous so that code that expects it to be consumed
        // will still work.
        if (this.current.type == 'TOKEN_EOF') return;

        while (this.peekChar() != '\0')
        {
            this.tokenStart = this.currentChar;

            let c = this.nextChar();
            switch (c) {
            case '(':
                // If we are inside an interpolated expression, count the unmatched "(".
                if (this.numParens > 0) this.parens[this.numParens - 1]++;
                this.makeToken('TOKEN_LEFT_PAREN');
                return;

            case ')':
            // If we are inside an interpolated expression, count the ")".
                if (this.numParens > 0 &&
                --this.parens[this.numParens - 1] == 0)
                {
                    // This is the final ")", so the interpolation expression has ended.
                    // This ")" now begins the next section of the template string.
                    this.numParens--;
                    this.readString();
                    return;
                }

                this.makeToken('TOKEN_RIGHT_PAREN');
                return;

            case '[': this.makeToken('TOKEN_LEFT_BRACKET'); return;
            case ']': this.makeToken('TOKEN_RIGHT_BRACKET'); return;
            case '{': this.makeToken('TOKEN_LEFT_BRACE'); return;
            case '}': this.makeToken('TOKEN_RIGHT_BRACE'); return;
            case ':': this.makeToken('TOKEN_COLON'); return;
            case ',': this.makeToken('TOKEN_COMMA'); return;
            case '*': this.makeToken('TOKEN_STAR'); return;
            case '%': this.makeToken('TOKEN_PERCENT'); return;
            case '^': this.makeToken('TOKEN_CARET'); return;
            case '+': this.makeToken('TOKEN_PLUS'); return;
            case '-': this.makeToken('TOKEN_MINUS'); return;
            case '~': this.makeToken('TOKEN_TILDE'); return;
            case '?': this.makeToken('TOKEN_QUESTION'); return;

            case '|': this.twoCharToken('|', 'TOKEN_PIPEPIPE', 'TOKEN_PIPE'); return;
            case '&': this.twoCharToken('&', 'TOKEN_AMPAMP', 'TOKEN_AMP'); return;
            case '=': this.twoCharToken('=', 'TOKEN_EQEQ', 'TOKEN_EQ'); return;
            case '!': this.twoCharToken('=', 'TOKEN_BANGEQ', 'TOKEN_BANG'); return;

            case '.':
                if (this.matchChar('.'))
                {
                    this.twoCharToken('.', 'TOKEN_DOTDOTDOT', 'TOKEN_DOTDOT');
                    return;
                }

                this.makeToken('TOKEN_DOT');
                return;

            case '/':
                if (this.matchChar('/'))
                {
                    this.skipLineComment();
                    break;
                }

                if (this.matchChar('*'))
                {
                    this.skipBlockComment();
                    break;
                }

                this.makeToken('TOKEN_SLASH');
                return;

            case '<':
                if (this.matchChar('<'))
                {
                    this.makeToken('TOKEN_LTLT');
                }
                else
                {
                    this.twoCharToken('=', 'TOKEN_LTEQ', 'TOKEN_LT');
                }
                return;

            case '>':
                if (this.matchChar('>'))
                {
                    this.makeToken('TOKEN_GTGT');
                }
                else
                {
                    this.twoCharToken('=', 'TOKEN_GTEQ', 'TOKEN_GT');
                }
                return;

            case '\n':
                this.makeToken('TOKEN_LINE');
                return;

            case ' ':
            case '\r':
            case '\t':
            // Skip forward until we run out of whitespace.
                while (this.peekChar() == ' ' ||
                   this.peekChar() == '\r' ||
                   this.peekChar() == '\t')
                {
                    this.nextChar();
                }
                break;

            case '"': this.readString(); return;
            case '_':
                this.readName(
                    this.peekChar() == '_' ? 'TOKEN_STATIC_FIELD' : 'TOKEN_FIELD');
                return;

            case '0':
                if (this.peekChar() == 'x')
                {
                    this.readHexNumber();
                    return;
                }

                this.readNumber();
                return;

            default:
                if (this.currentLine == 1 && c == '#' && this.peekChar() == '!')
                {
                    // Ignore shebang on the first line.
                    this.skipLineComment();
                    break;
                }
                if (this.isName(c))
                {
                    this.readName('TOKEN_NAME');
                }
                else if (this.isDigit(c))
                {
                    this.readNumber();
                }
                else
                {
                    if (c >= 32 && c <= 126)
                    {
                        this.lexError('Invalid character \'' + c + '\'.');
                    }
                    else
                    {
                        // Don't show non-ASCII values since we didn't UTF-8 decode the
                        // bytes. Since there are no non-ASCII byte values that are
                        // meaningful code units in Wren, the lexer works on raw bytes,
                        // even though the source code and console output are UTF-8.
                        this.lexError('Invalid byte 0x' + c + '.');
                    }
                    this.current.type = 'TOKEN_ERROR';
                    this.current.length = 0;
                }
                return;
            }
        }

        // If we get here, we're out of source, so just make EOF tokens.
        this.tokenStart = this.currentChar;
        this.makeToken('TOKEN_EOF');
    }


    // Outputs a lexical error.
    lexError(format) {
        console.warn([this.currentLine, 'Error', format]);
    }

}
