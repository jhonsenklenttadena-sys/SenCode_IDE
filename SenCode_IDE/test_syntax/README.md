# Syntax Checker Test Files

This directory contains test files with intentional syntax errors to verify that the syntax checking feature is working correctly across all supported languages in Group 1.

## Test Files

### Group 1 Languages (Already Implemented)
- **test.js** - JavaScript with missing closing brace
- **test.py** - Python with missing colon
- **TestJava.java** - Java with missing semicolons
- **test.cpp** - C++ with missing semicolons
- **test.c** - C with missing semicolons
- **test.cs** - C# with missing semicolons
- **test.php** - PHP with missing semicolons
- **test.go** - Go with missing closing parenthesis
- **test.rs** - Rust with missing semicolons

## How to Test

1. **Start the CodeForge app** in development mode:
   ```bash
   npm run electron:dev
   ```

2. **Open each test file** in the editor

3. **Expected behavior:**
   - Red wavy underlines should appear under syntax errors
   - Hovering over the underlined text should show the error message
   - The gutter should show error markers (red dots)
   - Errors should appear within 700ms after typing stops

4. **Verify for each language:**
   - The error is detected correctly
   - The error message is helpful
   - The position is accurate (underline is in the right place)

## Example Errors Expected

### Java
```
';' expected
```

### C/C++
```
expected ';' after expression
```

### C#
```
error CS1002: ; expected
```

### PHP
```
syntax error, unexpected end of file, expecting ',' or ';'
```

### Go
```
expected ')', found 'EOF'
```

### Rust
```
expected `;`
```

### JavaScript
```
Unexpected end of input
```

### Python
```
SyntaxError: invalid syntax
```

## Troubleshooting

If syntax checking doesn't work:

1. **Check runtime is installed:**
   - Open Extensions panel (top-right icon)
   - Verify the language runtime shows ✓ (installed)
   - If not installed, click "Install [Runtime Name]"

2. **Check console for errors:**
   - Open DevTools (F12 or Ctrl+Shift+I)
   - Look for errors in the Console tab
   - Check the IPC calls in the Network tab

3. **Verify the runtime is on PATH:**
   - Open Terminal panel in CodeForge
   - Run the checker command manually:
     - Java: `javac -version`
     - C/C++: `gcc --version` or `g++ --version`
     - C#: `dotnet --version`
     - PHP: `php --version`
     - Go: `go version`
     - Rust: `rustc --version`

4. **Check temp directory permissions:**
   - Syntax checkers write temporary files to `os.tmpdir()`
   - Ensure you have write permissions

## Implementation Notes

- Syntax checkers are **bundled with runtimes** (no separate download)
- Each checker uses the **native compiler/interpreter** from the runtime
- Errors are parsed from compiler output and converted to **CodeMirror diagnostics**
- Checking happens **700ms after typing stops** (debounced)
- Timeout is **8-15 seconds** depending on language (Java/C# are slower)

## Success Criteria

✅ All test files show syntax errors in the correct locations
✅ Error messages are clear and helpful
✅ Errors update in real-time as you type
✅ No false positives (correct code shows no errors)
✅ Performance is acceptable (< 1 second for most languages)
