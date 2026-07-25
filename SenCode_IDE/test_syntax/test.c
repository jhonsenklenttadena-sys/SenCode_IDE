#include <stdio.h>

int main() {
    printf("Hello World\n")  // Missing semicolon - should show error
    
    int x = 10
    int y = 20;  // Missing semicolon on line above
    
    printf("Sum: %d\n", x + y);
    return 0;
}
