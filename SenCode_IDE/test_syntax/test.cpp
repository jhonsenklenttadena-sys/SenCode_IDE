#include <iostream>
using namespace std;

int main() {
    cout << "Hello World"  // Missing semicolon - should show error
    
    int x = 10
    int y = 20;  // Missing semicolon on line above
    
    cout << "Sum: " << (x + y) << endl;
    return 0;
}
