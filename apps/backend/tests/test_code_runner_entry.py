from app.services.code_runner import _find_entry_js


def test_skips_constant_declared_before_the_function() -> None:
    code = (
        "const SLA = { P1: 60, P2: 240 };\n"
        "const RANK = { P1: 1, P2: 2 };\n"
        "function triageQueue(tickets, now) {\n  return [];\n}\n"
    )
    assert _find_entry_js(code) == "triageQueue"


def test_picks_the_function_no_one_else_calls() -> None:
    code = (
        "function timeLeft(t, now) { return t[2] - now; }\n"
        "const triageQueue = (tickets, now) => tickets.map((t) => timeLeft(t, now));\n"
    )
    assert _find_entry_js(code) == "triageQueue"


def test_arrow_and_function_expression_count_as_functions() -> None:
    assert _find_entry_js("const solve = function (a) { return a; };\n") == "solve"
    assert _find_entry_js("const solve = async (a) => a;\n") == "solve"


def test_falls_back_to_first_declaration_when_nothing_looks_like_a_function() -> None:
    assert _find_entry_js("const answer = 42;\n") == "answer"
