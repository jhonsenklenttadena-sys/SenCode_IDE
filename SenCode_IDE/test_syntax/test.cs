using System;

class Program {
    static void Main() {
        Console.WriteLine("Hello World")  // Missing semicolon - should show error
        
        int x = 10
        int y = 20;  // Missing semicolon on line above
        
        Console.WriteLine($"Sum: {x + y}");
    }
}
