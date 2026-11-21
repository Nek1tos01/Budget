cmake_minimum_required(VERSION 3.20)
project(BudgetCore LANGUAGES CXX)

add_library(budget_core STATIC src/money.cpp src/calendar.cpp src/engine.cpp)
target_include_directories(budget_core PUBLIC include)
target_compile_features(budget_core PUBLIC cxx_std_20)
set_target_properties(budget_core PROPERTIES CXX_EXTENSIONS OFF)

include(CTest)
if(BUILD_TESTING)
    add_executable(budget_core_test tests/core_test.cpp)
    target_link_libraries(budget_core_test PRIVATE budget_core)
    add_test(NAME budget_core_test COMMAND budget_core_test)
endif()
