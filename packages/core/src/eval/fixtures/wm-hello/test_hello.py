def test_greeting():
    result = "hello, world"
    assert result == "hello, world"
    assert len(result) > 0

def test_addition():
    assert 1 + 1 == 2
    assert 2 * 3 == 6
