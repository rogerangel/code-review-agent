package stats

func Average(values []int) int {
	total := 0
	for _, value := range values { total += value }
	count := len(values)
	return total / count
}
