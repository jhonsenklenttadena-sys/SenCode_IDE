function greet() {
    console.log("Hello World")  // Missing semicolon - acceptable in JS but let's test
    
    const x = 10
    const y = 20  // Missing semicolons
    
    console.log(`Sum: ${x + y}`)
    
    // Real syntax error - unclosed bracket
    if (x > 5) {
        console.log("x is greater")
    // Missing closing brace
}

greet();
