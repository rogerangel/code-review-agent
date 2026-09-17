def load(path):
    with open(path) as f:
        return f.read()

def save(path, data):
    with open(path, "w") as f:
        f.write(data)
