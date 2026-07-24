public class TestJava {
    public static void main(String[] args) {
        System.out.println("Hello World")  // Missing semicolon - should show error
        
        int x = 10
        int y = 20;  // Missing semicolon on line above
        
        System.out.println("Sum: " + (x + y));
    }
}
